import type { WebSocket } from "@fastify/websocket";
import { loadSession } from "@portikus/auth";
import type { Workspace } from "@portikus/contracts";
import { ClientMessage, type ServerMessage } from "@portikus/events";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { ServerDeps } from "../server.js";
import { countActive, findOwnedWorkspace, toWorkspace } from "./workspace-view.js";

const UuidParam = z.object({ id: z.string().uuid() });

/** How often the watcher polls for workspace changes. */
const POLL_INTERVAL_MS = 1000;

interface Watcher {
	sockets: Set<WebSocket>;
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

	function startWatcher(workspaceId: string, signature: string): Watcher {
		const interval = setInterval(async () => {
			const watcher = watchers.get(workspaceId);
			if (!watcher) return;
			try {
				const workspace = await readWorkspace(workspaceId);
				if (!workspace) return;
				const next = signatureOf(workspace);
				if (next === watcher.signature) return;
				watcher.signature = next;
				for (const socket of watcher.sockets) {
					send(socket, workspace);
				}
			} catch (error) {
				app.log.error({ err: error }, "workspace watcher poll failed");
			}
		}, POLL_INTERVAL_MS);
		const watcher: Watcher = { sockets: new Set(), interval, signature };
		watchers.set(workspaceId, watcher);
		return watcher;
	}

	function leave(workspaceId: string, socket: WebSocket): void {
		const watcher = watchers.get(workspaceId);
		if (!watcher) return;
		watcher.sockets.delete(socket);
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
				const user = request.user;
				if (!user) {
					return reply
						.status(401)
						.send({ code: "UNAUTHORIZED", message: "Sign in to continue" });
				}
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
			},
		},
		async (socket: WebSocket, request: FastifyRequest) => {
			const workspaceId = (request.params as { id: string }).id;
			const connectionId = crypto.randomUUID();
			const now = new Date().toISOString();

			await db
				.insertInto("workspace_connections")
				.values({ id: connectionId, workspace_id: workspaceId })
				.execute();

			await db
				.updateTable("workspaces")
				.set({
					desired_state: "running",
					last_active_connection_at: now,
					updated_at: now,
				})
				.where("id", "=", workspaceId)
				.execute();

			const workspace = await readWorkspace(workspaceId);
			if (workspace) send(socket, workspace);

			const watcher =
				watchers.get(workspaceId) ??
				startWatcher(workspaceId, workspace ? signatureOf(workspace) : "");
			watcher.sockets.add(socket);

			socket.on("message", async (raw: Buffer | string) => {
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

				await db
					.updateTable("workspace_connections")
					.set({ last_seen_at: new Date().toISOString() })
					.where("id", "=", connectionId)
					.execute();
			});

			socket.on("close", async () => {
				leave(workspaceId, socket);
				try {
					await db
						.deleteFrom("workspace_connections")
						.where("id", "=", connectionId)
						.execute();
				} catch (error) {
					app.log.error({ err: error }, "failed to delete workspace connection");
				}
			});
		},
	);

	// Stop polling when the server shuts down. The close frames are sent by the
	// preClose hook in server.ts, before @fastify/websocket drops the sockets.
	app.addHook("onClose", async () => {
		for (const [workspaceId, watcher] of watchers) {
			clearInterval(watcher.interval);
			watchers.delete(workspaceId);
		}
	});
}
