import type { WebSocket } from "@fastify/websocket";
import { loadSession, requireUser } from "@portikus/auth";
import type { Workspace } from "@portikus/contracts";
import { ClientMessage, type ServerMessage } from "@portikus/events";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { log } from "../log.js";
import type { ServerDeps } from "../server.js";
import { dropPresence, openPresence, touchPresence } from "./presence.js";
import { countActive, findOwnedWorkspace, toWorkspace } from "./workspace-view.js";

const UuidParam = z.object({ id: z.string().uuid() });

/** How often the watcher polls for workspace changes. */
const POLL_INTERVAL_MS = 1000;

/** Concurrent sockets allowed per workspace (SPEC.md §24.2). */
const MAX_CONNECTIONS_PER_WORKSPACE = 16;

interface Subscriber {
	socket: WebSocket;
	connectionId: string;
	sessionToken: string | null;
}

interface Watcher {
	sockets: Set<Subscriber>;
	interval: NodeJS.Timeout;
	signature: string;
}

function signatureOf(workspace: Workspace): string {
	return JSON.stringify([
		workspace.state,
		workspace.desiredState,
		workspace.errorCode,
		workspace.shutdownDeadline,
		workspace.activeConnections,
	]);
}

/**
 * The authenticated workspace WebSocket. It is both the live view of the
 * workspace and the presence signal the worker uses (SPEC.md §5.3, §5.4, §6.4).
 */
export function registerWorkspaceSocket(
	app: FastifyInstance,
	{ db, config }: ServerDeps,
): void {
	const watchers = new Map<string, Watcher>();

	// Database work started by a socket event or a watcher tick finishes after
	// the request that caused it. Shutdown has to wait for it: a query that
	// outlives the pool leaves its connection checked out, and closing the pool
	// then waits for that connection forever.
	const pending = new Set<Promise<unknown>>();
	function track(work: Promise<unknown>): void {
		pending.add(work);
		void work.finally(() => pending.delete(work));
	}

	async function readWorkspace(id: string): Promise<Workspace | null> {
		const row = await db
			.selectFrom("workspaces")
			.selectAll()
			.where("id", "=", id)
			.executeTakeFirst();
		if (!row) return null;
		const active = await countActive(db, id, config);
		return toWorkspace(row as Record<string, unknown>, active, config);
	}

	function send(socket: WebSocket, workspace: Workspace): void {
		const message: ServerMessage = { type: "workspace", workspace };
		socket.send(JSON.stringify(message));
	}

	async function dropConnection(connectionId: string): Promise<void> {
		await dropPresence(db, connectionId);
	}

	/**
	 * Revocation must take effect at once, so every tick re-checks the session
	 * behind each open socket (SPEC.md §5.3).
	 */
	async function dropRevoked(watcher: Watcher): Promise<void> {
		for (const subscriber of [...watcher.sockets]) {
			const user = subscriber.sessionToken
				? await loadSession(db, subscriber.sessionToken)
				: null;
			if (user) continue;
			watcher.sockets.delete(subscriber);
			subscriber.socket.close(4401, "session revoked");
			await dropConnection(subscriber.connectionId);
		}
	}

	function startWatcher(workspaceId: string, signature: string): Watcher {
		async function poll(): Promise<void> {
			const watcher = watchers.get(workspaceId);
			if (!watcher) return;
			try {
				await dropRevoked(watcher);
				const workspace = await readWorkspace(workspaceId);
				if (!workspace) {
					for (const subscriber of watcher.sockets) {
						subscriber.socket.close(1001, "workspace is gone");
					}
					return;
				}
				const next = signatureOf(workspace);
				if (next === watcher.signature) return;
				watcher.signature = next;
				for (const subscriber of watcher.sockets) {
					send(subscriber.socket, workspace);
				}
			} catch (error) {
				log("error", {
					msg: "workspace watcher poll failed",
					workspaceId,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}

		const interval = setInterval(() => track(poll()), POLL_INTERVAL_MS);
		const watcher: Watcher = { sockets: new Set(), interval, signature };
		watchers.set(workspaceId, watcher);
		return watcher;
	}

	function leave(workspaceId: string, subscriber: Subscriber): void {
		const watcher = watchers.get(workspaceId);
		if (!watcher) return;
		watcher.sockets.delete(subscriber);
		if (watcher.sockets.size === 0) {
			clearInterval(watcher.interval);
			watchers.delete(workspaceId);
		}
	}

	app.get(
		"/workspaces/:id/ws",
		{
			websocket: true,
			preHandler: async (request, reply) => {
				const user = requireUser(request);
				const params = UuidParam.safeParse(request.params);
				if (!params.success) {
					return reply
						.status(400)
						.send({ code: "VALIDATION_FAILED", message: params.error.message });
				}
				const row = await findOwnedWorkspace(db, user, params.data.id);
				if (!row) {
					return reply
						.status(404)
						.send({ code: "WORKSPACE_NOT_FOUND", message: "Workspace not found" });
				}
				const active = await countActive(db, params.data.id, config);
				if (active >= MAX_CONNECTIONS_PER_WORKSPACE) {
					return reply.status(429).send({
						code: "TOO_MANY_CONNECTIONS",
						message: "This workspace already has too many open connections",
					});
				}
			},
		},
		async (socket: WebSocket, request: FastifyRequest) => {
			const workspaceId = (request.params as { id: string }).id;
			const connectionId = crypto.randomUUID();

			await openPresence(db, workspaceId, connectionId);

			const workspace = await readWorkspace(workspaceId);
			if (workspace) send(socket, workspace);

			const subscriber: Subscriber = {
				socket,
				connectionId,
				sessionToken: request.sessionToken,
			};
			const watcher =
				watchers.get(workspaceId) ??
				startWatcher(workspaceId, workspace ? signatureOf(workspace) : "");
			watcher.sockets.add(subscriber);

			async function onMessage(raw: Buffer | string): Promise<void> {
				// An unhandled rejection in this listener would end the process.
				try {
					let parsed: unknown;
					try {
						parsed = JSON.parse(raw.toString());
					} catch {
						return; // Malformed frames are ignored.
					}
					if (!ClientMessage.safeParse(parsed).success) return;

					// Revocation must take effect at once, so re-check the session
					// on every heartbeat (SPEC.md §5.3).
					const user = request.sessionToken
						? await loadSession(db, request.sessionToken)
						: null;
					if (!user) {
						socket.close(4401, "session expired");
						return;
					}

					await touchPresence(db, connectionId);
				} catch (error) {
					log("error", {
						msg: "workspace socket message failed",
						workspaceId,
						error: error instanceof Error ? error.message : String(error),
					});
					socket.close(1011, "internal error");
				}
			}

			async function onSocketClose(): Promise<void> {
				leave(workspaceId, subscriber);
				try {
					await dropConnection(connectionId);
				} catch (error) {
					log("error", {
						msg: "failed to delete workspace connection",
						connectionId,
						error: error instanceof Error ? error.message : String(error),
					});
				}
			}

			socket.on("message", (raw: Buffer | string) => track(onMessage(raw)));
			socket.on("close", () => track(onSocketClose()));
		},
	);

	// Stop polling when the server shuts down. The close frames are sent by the
	// preClose hook in server.ts, before @fastify/websocket drops the sockets.
	app.addHook("onClose", async () => {
		for (const [workspaceId, watcher] of watchers) {
			clearInterval(watcher.interval);
			watchers.delete(workspaceId);
		}
		// A tick or a close handler already running can start more work, so
		// keep draining until nothing is left.
		while (pending.size > 0) {
			await Promise.allSettled([...pending]);
		}
	});
}
