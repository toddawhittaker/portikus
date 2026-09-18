import type { WebSocket } from "@fastify/websocket";
import type { FsEvent } from "@portikus/contracts";
import type { FastifyInstance } from "fastify";
import { AgentFailure } from "./tmux.js";
import { ProjectWatchers } from "./watch.js";

export interface EventsRouteOptions {
	homeDir: string;
}

/** Close code for a project that does not exist (SPEC.md §11.4). */
const NOT_FOUND_CLOSE = 4404;

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

	instance.addHook("preClose", async () => {
		watchers.closeEverything();
	});

	instance.get(
		"/projects/:slug/events",
		{ websocket: true },
		async (socket: WebSocket, request) => {
			const { slug } = request.params as { slug: string };
			let unsubscribe: (() => void) | null = null;
			let closed = false;
			socket.on("close", () => {
				closed = true;
				unsubscribe?.();
			});
			try {
				const stop = await watchers.subscribe(
					options.homeDir,
					slug,
					(event: FsEvent) => {
						if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(event));
					},
				);
				// The socket may have closed while the watcher was starting.
				if (closed) {
					stop();
					return;
				}
				unsubscribe = stop;
				request.log.debug({ slug }, "project events subscribed");
			} catch (error) {
				const code = error instanceof AgentFailure ? error.code : "WATCH_FAILED";
				socket.send(JSON.stringify({ type: "error", code }));
				socket.close(
					code === "PROJECT_NOT_FOUND" || code === "INVALID_SLUG"
						? NOT_FOUND_CLOSE
						: 1008,
					code,
				);
			}
		},
	);
}
