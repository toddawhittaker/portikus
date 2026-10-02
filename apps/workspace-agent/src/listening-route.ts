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
import { sendError } from "./errors.js";
import type { Forwards } from "./forwards.js";
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
		// An open events socket is what keeps the timer scanning (SPEC.md §18.2).
		const unwatch = monitor.watch();
		socket.on("close", () => {
			unsubscribe();
			unwatch();
		});
		// The first frame is the whole list, so a client that connects
		// between changes still knows what is running.
		send(socket, monitor.current());
		await monitor.refresh();
	});

	/** Stop what holds a port (SPEC.md §18.2). */
	instance.post("/listening/:port/stop", async (request, reply) => {
		const { port } = request.params as { port: string };
		const parsed = PortNumber.safeParse(Number.parseInt(port, 10));
		if (!parsed.success) {
			return reply
				.code(400)
				.send({ error: { code: "BAD_REQUEST", message: "invalid port" } });
		}
		try {
			await monitor.stopListener(parsed.data);
		} catch (error) {
			return sendError(request, reply, error, "INTERNAL");
		}
		// The next scan drops the row; report what was asked and done.
		await monitor.refresh();
		return { port: parsed.data, stopped: true };
	});

	/** Settle a port's protocol when a preview first asks. */
	// jscpd:ignore-start -- each route spells out its own checks, in order.
	instance.post("/listening/:port/probe", async (request, reply) => {
		const { port } = request.params as { port: string };
		const parsed = PortNumber.safeParse(Number.parseInt(port, 10));
		if (!parsed.success) {
			return reply
				.code(400)
				.send({ error: { code: "BAD_REQUEST", message: "invalid port" } });
		}
		const service = await monitor.probeProtocol(parsed.data);
		if (!service) {
			return reply.code(404).send({
				error: {
					code: "LISTENER_NOT_FOUND",
					message: "nothing is listening on that port",
				},
			});
		}
		return { service };
	});
	// jscpd:ignore-end

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
			return sendError(request, reply, error, "INTERNAL");
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
