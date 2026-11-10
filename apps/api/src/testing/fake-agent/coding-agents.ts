import type { WebSocket } from "@fastify/websocket";
import type { AgentCodingAgentStatus, PlanUsage } from "@portikus/contracts";
import type { FastifyInstance } from "fastify";
import type { FakeAgentState } from "./state.js";

/** One frame with the whole list, like the real agent's. */
export function sendCodingAgents(
	socket: WebSocket,
	terminals: AgentCodingAgentStatus[],
): void {
	if (socket.readyState !== socket.OPEN) return;
	socket.send(JSON.stringify({ type: "workspace.coding-agents.changed", terminals }));
}

/**
 * Agent states on the listening socket, and `GET /agent-limits`, with hooks
 * to set both. The real agent reads them from the coding agents' hooks.
 */
export function registerCodingAgentRoutes(
	app: FastifyInstance,
	s: FakeAgentState,
): void {
	const { codingAgents, codingAgentsHeld, agentLimits, listeningSockets, keyOf } = s;

	/**
	 * Hold back every agent-state frame for a workspace key (`hold: true`), as
	 * an agent that has not reported yet; `hold: false` sends the current
	 * list to the listening sockets as the first frame.
	 */
	app.post("/__test/coding-agents-hold", async (request, reply) => {
		const body = (request.body ?? {}) as { key?: string; hold?: boolean };
		const key = body.key ?? "";
		if (body.hold === false) {
			codingAgentsHeld.delete(key);
			for (const socket of listeningSockets.get(key) ?? []) {
				sendCodingAgents(socket, codingAgents.get(key) ?? []);
			}
		} else {
			codingAgentsHeld.add(key);
		}
		return reply.status(204).send();
	});

	app.get(
		"/agent-limits",
		async (request) => agentLimits.get(keyOf(request)) ?? { providers: [] },
	);

	/**
	 * Set the whole list of agent states for a workspace key and push it to
	 * the listening sockets. `since` defaults to now.
	 */
	app.post("/__test/coding-agents", async (request, reply) => {
		const body = (request.body ?? {}) as {
			key?: string;
			terminals?: Array<Omit<AgentCodingAgentStatus, "since"> & { since?: string }>;
		};
		const key = body.key ?? "";
		const terminals = (body.terminals ?? []).map((one) => ({
			...one,
			since: one.since ?? new Date().toISOString(),
		}));
		codingAgents.set(key, terminals);
		if (codingAgentsHeld.has(key)) return reply.status(204).send();
		for (const socket of listeningSockets.get(key) ?? []) {
			sendCodingAgents(socket, terminals);
		}
		return reply.status(204).send();
	});

	/**
	 * Set what `GET /agent-limits` answers for a workspace key: the providers
	 * with a 7-day figure. `observedAt` defaults to now.
	 */
	app.post("/__test/agent-limits", async (request, reply) => {
		const body = (request.body ?? {}) as {
			key?: string;
			providers?: Array<Omit<PlanUsage, "observedAt"> & { observedAt?: string }>;
		};
		agentLimits.set(body.key ?? "", {
			providers: (body.providers ?? []).map((one) => ({
				...one,
				observedAt: one.observedAt ?? new Date().toISOString(),
			})),
		});
		return reply.status(204).send();
	});
}
