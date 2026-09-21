/**
 * The agent's listening-port and loopback-forward routes (SPEC.md §14.7,
 * §18.2, BROWSER-HANDLING.md §11.1, §17). Token auth is applied by the
 * server's own preHandler hook, upgrades included (SPEC.md §23.5).
 */
import type { WebSocket } from "@fastify/websocket";
import {
	type AgentListeningService,
	LoopbackForwardRequest,
	PortNumber,
} from "@portikus/contracts";
import type { FastifyInstance } from "fastify";
import { ForwardFailure, type Forwards } from "./forwards.js";
import type { ListeningMonitor } from "./listening.js";

export interface ListeningRouteOptions {
	monitor: ListeningMonitor;
	forwards: Forwards;
}

export async function listeningRoutes(
	instance: FastifyInstance,
	options: ListeningRouteOptions,
): Promise<void> {
	const { monitor, forwards } = options;

	instance.get("/listening", async () => {
		await monitor.refresh();
		return { services: monitor.current() };
	});

	instance.get("/listening/events", { websocket: true }, async (socket: WebSocket) => {
		const unsubscribe = monitor.subscribe((services) => {
			send(socket, services);
		});
		socket.on("close", unsubscribe);
		// The first frame is the whole list, so a client that connects
		// between changes still knows what is running.
		send(socket, monitor.current());
		await monitor.refresh();
	});

	instance.get("/forwards", async () => ({ forwards: forwards.list() }));

	instance.post("/forwards", async (request, reply) => {
		const parsed = LoopbackForwardRequest.safeParse(request.body);
		if (!parsed.success) {
			return reply
				.code(400)
				.send({ error: { code: "BAD_REQUEST", message: "invalid port" } });
		}
		try {
			return await forwards.open(parsed.data.port);
		} catch (error) {
			if (error instanceof ForwardFailure) {
				return reply
					.code(error.status)
					.send({ error: { code: error.code, message: error.message } });
			}
			request.log.error(
				{ error: error instanceof Error ? error.message : String(error) },
				"loopback forward failed",
			);
			return reply
				.code(500)
				.send({ error: { code: "INTERNAL", message: "internal error" } });
		}
	});

	instance.delete("/forwards/:port", async (request, reply) => {
		const { port } = request.params as { port: string };
		const parsed = PortNumber.safeParse(Number.parseInt(port, 10));
		if (!parsed.success || !forwards.close(parsed.data)) {
			return reply
				.code(404)
				.send({ error: { code: "FORWARD_NOT_FOUND", message: "no such forward" } });
		}
		return reply.code(204).send();
	});
}

function send(socket: WebSocket, services: AgentListeningService[]): void {
	if (socket.readyState !== socket.OPEN) return;
	socket.send(
		JSON.stringify({
			type: "workspace.listening-services.changed",
			services,
			observedAt: new Date().toISOString(),
		}),
	);
}
