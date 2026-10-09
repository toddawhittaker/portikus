import type { WebSocket } from "@fastify/websocket";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { FakeAgentState } from "./state.js";

/** The project events socket, like the agent's events-route.ts (SPEC.md §11.4). */
export function registerEventRoutes(app: FastifyInstance, s: FakeAgentState): void {
	const {
		flags,
		eventSockets,
		hiddenEventSockets,
		watchFailures,
		eventCloses,
		answerKey,
		keyOf,
		dirs,
		pushEvent,
		pushOversizedEvent,
	} = s;
	app.get(
		"/projects/:slug/events",
		{ websocket: true },
		(socket: WebSocket, request: FastifyRequest) => {
			const slug = (request.params as { slug: string }).slug;
			// Anything the browser sends must never reach here; count it so a
			// test can prove the pipe is one-way.
			socket.on("message", () => {
				flags.eventsReceived += 1;
			});
			socket.on("close", (code: number, reason: Buffer) => {
				eventCloses.push({ code, reason: reason.toString() });
			});
			// Like the real agent, the reason is an error frame and the close
			// code only carries the kind of failure (SPEC.md §11.4).
			if (!dirs(request).has(slug)) {
				socket.send(JSON.stringify({ type: "error", code: "PROJECT_NOT_FOUND" }));
				socket.close(4404, "PROJECT_NOT_FOUND");
				return;
			}
			if (flags.eventLimit) {
				socket.send(JSON.stringify({ type: "error", code: "EVENT_SOCKET_LIMIT" }));
				socket.close(1008, "EVENT_SOCKET_LIMIT");
				return;
			}
			const key = answerKey(keyOf(request), slug);
			if (watchFailures.has(key)) {
				socket.send(JSON.stringify({ type: "error", code: "WATCH_FAILED" }));
				socket.close(1011, "WATCH_FAILED");
				return;
			}
			const peers = eventSockets.get(key) ?? new Set<WebSocket>();
			peers.add(socket);
			if ((request.query as { hidden?: string }).hidden === "1") {
				hiddenEventSockets.add(socket);
			}
			eventSockets.set(key, peers);
			socket.on("close", () => peers.delete(socket));
			// The real agent says the watcher is live before anything else.
			socket.send(
				JSON.stringify({ type: "fs", paths: [], git: true, truncated: true }),
			);
		},
	);

	app.post("/__test/events", async (request, reply) => {
		const body = request.body as {
			key?: string;
			slug: string;
			frame?: unknown;
			oversized?: boolean;
		};
		const sent = body.oversized
			? pushOversizedEvent(body.key ?? "", body.slug)
			: pushEvent(body.key ?? "", body.slug, body.frame);
		return reply.status(200).send({ sent });
	});
}
