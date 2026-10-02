import type { WebSocket } from "@fastify/websocket";
import { CloseCode, type FsEvent, MAX_EVENT_SOCKETS } from "@portikus/contracts";
import type { FastifyInstance } from "fastify";
import { AgentFailure } from "./errors.js";
import { ProjectWatchers, WatchLimitedError } from "./watch.js";

export interface EventsRouteOptions {
	homeDir: string;
	/** Overrides the socket cap. For tests. */
	maxSockets?: number;
	/** Overrides the watchers, so a test can break one. For tests. */
	watchers?: ProjectWatchers;
}

/** Close code for a socket that is done and should not be retried. */
const NORMAL_CLOSE = 1000;

/**
 * `GET /projects/:slug/events`: batched filesystem change frames for one
 * project, for as long as the socket is open (SPEC.md §11.4, STACK.md §5).
 * Token auth is applied by the server's own preHandler hook, upgrades
 * included (SPEC.md §23.5).
 */
export async function eventsRoute(
	instance: FastifyInstance,
	options: EventsRouteOptions,
): Promise<void> {
	const watchers = options.watchers ?? new ProjectWatchers(instance.log);
	const maxSockets = options.maxSockets ?? MAX_EVENT_SOCKETS;
	let open = 0;

	instance.addHook("preClose", async () => {
		watchers.closeEverything();
	});

	instance.get(
		"/projects/:slug/events",
		{ websocket: true },
		async (socket: WebSocket, request) => {
			const { slug } = request.params as { slug: string };

			if (open >= maxSockets) {
				send(socket, { type: "error", code: "EVENT_SOCKET_LIMIT" });
				socket.close(CloseCode.POLICY, "EVENT_SOCKET_LIMIT");
				return;
			}
			open += 1;

			let unsubscribe: (() => void) | null = null;
			let closed = false;
			socket.on("close", () => {
				if (!closed) open -= 1;
				closed = true;
				unsubscribe?.();
			});
			try {
				const stop = await watchers.subscribe(
					options.homeDir,
					slug,
					(event: FsEvent | null) => {
						if (event !== null) {
							send(socket, event);
							return;
						}
						// The watcher is gone, so this socket can carry nothing
						// more. Closing with 1011 is what makes the browser
						// reconnect and refetch everything (SPEC.md §11.4).
						send(socket, { type: "error", code: "WATCH_FAILED" });
						socket.close(CloseCode.SERVER_ERROR, "WATCH_FAILED");
					},
				);
				// The socket may have closed while the watcher was starting.
				if (closed) {
					stop();
					return;
				}
				unsubscribe = stop;
				// Tells the client the watcher is live, so anything it snapshots
				// from here on cannot miss a change (SPEC.md §11.4).
				send(socket, { type: "fs", paths: [], git: true, truncated: true });
				request.log.debug({ slug }, "project events subscribed");
			} catch (error) {
				if (error instanceof WatchLimitedError) {
					// Sent instead of an error: a retry would scan the whole tree
					// again, so the browser refreshes on focus (SPEC.md §11.4).
					send(socket, { type: "watch_limited" });
					socket.close(NORMAL_CLOSE, "WATCH_LIMITED");
					return;
				}
				const code = error instanceof AgentFailure ? error.code : "WATCH_FAILED";
				send(socket, { type: "error", code });
				socket.close(closeCodeFor(code), code);
			}
		},
	);
}

function closeCodeFor(code: string): number {
	if (code === "PROJECT_NOT_FOUND") return CloseCode.NOT_FOUND;
	if (code === "WATCH_FAILED") return CloseCode.SERVER_ERROR;
	return CloseCode.POLICY;
}

function send(socket: WebSocket, message: unknown): void {
	if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
}
