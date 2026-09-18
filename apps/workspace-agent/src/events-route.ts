import type { WebSocket } from "@fastify/websocket";
import { type FsEvent, MAX_EVENT_SOCKETS } from "@portikus/contracts";
import type { FastifyInstance } from "fastify";
import { AgentFailure } from "./tmux.js";
import { ProjectWatchers } from "./watch.js";

export interface EventsRouteOptions {
	homeDir: string;
	/** Overrides the socket cap. For tests. */
	maxSockets?: number;
}

/** Close code for a project that does not exist (SPEC.md §11.4). */
const NOT_FOUND_CLOSE = 4404;

/** Close code for a request the client should not retry as-is. */
const POLICY_CLOSE = 1008;

/** Close code for a failure on our side. */
const SERVER_ERROR_CLOSE = 1011;

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
	const watchers = new ProjectWatchers(instance.log);
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
				socket.close(POLICY_CLOSE, "EVENT_SOCKET_LIMIT");
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
					(event: FsEvent) => {
						send(socket, event);
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
				const code = error instanceof AgentFailure ? error.code : "WATCH_FAILED";
				send(socket, { type: "error", code });
				socket.close(closeCodeFor(code), code);
			}
		},
	);
}

function closeCodeFor(code: string): number {
	if (code === "PROJECT_NOT_FOUND") return NOT_FOUND_CLOSE;
	if (code === "WATCH_FAILED") return SERVER_ERROR_CLOSE;
	return POLICY_CLOSE;
}

function send(socket: WebSocket, message: unknown): void {
	if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
}
