import type { WebSocket } from "@fastify/websocket";
import { loadSession, sessionGate } from "@portikus/auth";
import type { ListeningService, Workspace } from "@portikus/contracts";
import { ClientMessage, type ServerMessage } from "@portikus/events";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { recordActivity } from "../activity.js";
import type { ListeningRegistry } from "../preview/registry.js";
import type { ServerDeps } from "../server.js";
import {
	createPendingWork,
	dropPresence,
	openPresence,
	touchPresence,
	workspaceUpgradeGuard,
} from "./presence.js";
import { countActive, toWorkspace } from "./workspace-view.js";

/** How often the watcher polls for workspace changes. */
const POLL_INTERVAL_MS = 1000;

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
		// A Reset Docker or Rebuild request must reach the browser at once (SPEC.md §27).
		workspace.pendingOperation,
		workspace.archivedAt,
		// The throttle notice and "Still working?" must appear at once (ADR 0032).
		workspace.cpuThrottle,
		workspace.idleStopAt,
	]);
}

/**
 * The authenticated workspace WebSocket. It is both the live view of the
 * workspace and the presence signal the worker uses (SPEC.md §5.3, §5.4, §6.4).
 */
export function registerWorkspaceSocket(
	app: FastifyInstance,
	{ db, config, logger, registry }: ServerDeps & { registry: ListeningRegistry },
): void {
	const watchers = new Map<string, Watcher>();
	// Administrator sockets write no presence rows, so they are counted here.
	const adminSockets = new Map<string, number>();

	const { track, drain } = createPendingWork();

	async function readWorkspace(id: string): Promise<Workspace | null> {
		const row = await db
			.selectFrom("workspaces")
			.selectAll()
			.where("id", "=", id)
			.executeTakeFirst();
		if (!row) return null;
		const active = await countActive(db, id, config);
		return toWorkspace(db, row as Record<string, unknown>, active, config);
	}

	function send(socket: WebSocket, workspace: Workspace): void {
		const message: ServerMessage = { type: "workspace", workspace };
		socket.send(JSON.stringify(message));
	}

	/** What is listening inside the workspace right now (BH §11.1). */
	function sendListening(socket: WebSocket, services: ListeningService[]): void {
		if (socket.readyState !== socket.OPEN) return;
		const message: ServerMessage = { type: "listening-services", services };
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
			if (user && !sessionGate(user)) continue;
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
				logger.error({ err: error, workspaceId }, "workspace watcher poll failed");
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
			// A HEAD twin would reach the socket handler and crash (issue #402).
			exposeHeadRoute: false,
			preHandler: workspaceUpgradeGuard(db, config, { ownerOnly: false, adminSockets }),
		},
		async (socket: WebSocket, request: FastifyRequest) => {
			// Hold incoming frames until the listeners below are attached, so a
			// browser that closes during this setup cannot be missed.
			socket.pause();

			const workspaceId = (request.params as { id: string }).id;
			const connectionId = crypto.randomUUID();

			// An administrator looking at a student's workspace is not presence: it
			// must not start the workspace or hold it up (SPEC.md §20.2).
			const present = request.workspaceRow?.owner_user_id === request.user?.id;
			if (!present) {
				adminSockets.set(workspaceId, (adminSockets.get(workspaceId) ?? 0) + 1);
			}
			let released = present;
			const releaseAdmin = (): void => {
				if (released) return;
				released = true;
				const left = (adminSockets.get(workspaceId) ?? 1) - 1;
				if (left > 0) adminSockets.set(workspaceId, left);
				else adminSockets.delete(workspaceId);
			};

			try {
				await setUp();
			} catch (error) {
				request.log.error({ err: error, workspaceId }, "workspace socket setup failed");
				releaseAdmin();
				track(dropConnection(connectionId).catch(() => {}));
				socket.close(1011, "internal error");
				socket.resume();
			}

			async function setUp(): Promise<void> {
				if (present) await openPresence(db, workspaceId, connectionId);

				if (socket.readyState !== socket.OPEN) {
					// The browser gave up while we were writing presence.
					track(dropConnection(connectionId).catch(() => {}));
					releaseAdmin();
					socket.resume();
					return;
				}

				const workspace = await readWorkspace(workspaceId);
				if (socket.readyState !== socket.OPEN) {
					// The browser gave up while we were reading the workspace.
					track(dropConnection(connectionId).catch(() => {}));
					releaseAdmin();
					socket.resume();
					return;
				}
				if (workspace) send(socket, workspace);
				// The current list first, then every change while the socket lives.
				// Only the owner gets it: command lines, pids and container names can
				// carry secrets an administrator must not see (SPEC.md §20.2).
				let unsubscribe = (): void => {};
				if (present) {
					sendListening(socket, registry.services(workspaceId));
					unsubscribe = registry.subscribe(workspaceId, (services) => {
						sendListening(socket, services);
					});
				}

				const subscriber: Subscriber = {
					socket,
					connectionId,
					sessionToken: request.sessionToken,
				};
				const watcher =
					watchers.get(workspaceId) ??
					startWatcher(workspaceId, workspace ? signatureOf(workspace) : "");
				watcher.sockets.add(subscriber);

				request.log.debug(
					{ workspaceId, connectionId, userId: request.user?.id },
					"workspace socket opened",
				);

				async function onMessage(raw: Buffer | string): Promise<void> {
					// An unhandled rejection in this listener would end the process.
					try {
						let parsed: unknown;
						try {
							parsed = JSON.parse(raw.toString());
						} catch {
							return; // Malformed frames are ignored.
						}
						const message = ClientMessage.safeParse(parsed);
						if (!message.success) return;

						// Revocation must take effect at once, so re-check the session
						// on every heartbeat (SPEC.md §5.3).
						const user = request.sessionToken
							? await loadSession(db, request.sessionToken)
							: null;
						if (!user || sessionGate(user)) {
							socket.close(4401, "session expired");
							return;
						}

						if (present) await touchPresence(db, connectionId);
						// Only the owner's own key presses hold off idle stop (ADR 0032).
						if (present && message.data.type === "activity") {
							await recordActivity(db, workspaceId);
						}
					} catch (error) {
						request.log.error(
							{ err: error, workspaceId },
							"workspace socket message failed",
						);
						socket.close(1011, "internal error");
					}
				}

				async function onSocketClose(): Promise<void> {
					unsubscribe();
					releaseAdmin();
					leave(workspaceId, subscriber);
					request.log.debug(
						{ workspaceId, connectionId, userId: request.user?.id },
						"workspace socket closed",
					);
					try {
						await dropConnection(connectionId);
					} catch (error) {
						request.log.error(
							{ err: error, connectionId },
							"failed to delete workspace connection",
						);
					}
				}

				socket.on("message", (raw: Buffer | string) => track(onMessage(raw)));
				socket.on("close", () => track(onSocketClose()));
				socket.resume();
			}
		},
	);

	// Stop polling when the server shuts down. The close frames are sent by the
	// preClose hook in server.ts, before @fastify/websocket drops the sockets.
	app.addHook("onClose", async () => {
		for (const [workspaceId, watcher] of watchers) {
			clearInterval(watcher.interval);
			watchers.delete(workspaceId);
		}
		await drain();
	});
}
