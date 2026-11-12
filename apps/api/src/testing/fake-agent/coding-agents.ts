import type { WebSocket } from "@fastify/websocket";
import {
	type AgentCodingAgentStatus,
	agentTitleText,
	type PlanUsage,
	TerminalQuestionAnswer,
} from "@portikus/contracts";
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
 * Retitle one chat in a workspace's list and push the list, as the real chat
 * host's title post does. A terminal not in the list is left alone.
 */
export function setCodingAgentTitle(
	s: FakeAgentState,
	key: string,
	terminalId: string,
	raw: string,
): void {
	const title = agentTitleText(raw);
	const list = (s.codingAgents.get(key) ?? []).map((one) =>
		one.terminalId === terminalId ? { ...one, title: title || undefined } : one,
	);
	s.codingAgents.set(key, list);
	if (s.codingAgentsHeld.has(key)) return;
	for (const socket of s.listeningSockets.get(key) ?? [])
		sendCodingAgents(socket, list);
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

	// Answers the API forwarded, by workspace key, for a test to read back.
	const questionAnswers = new Map<string, TerminalQuestionAnswer[]>();

	/**
	 * The API's forward of a terminal question's answer. 204 when that
	 * terminal's entry holds the question (set through `/__test/coding-agents`
	 * with a `question`); the question then clears, as the real agent's does.
	 * 409 when none waits.
	 */
	app.post("/terminals/:id/question", async (request, reply) => {
		const key = keyOf(request);
		const { id } = request.params as { id: string };
		const answer = TerminalQuestionAnswer.safeParse(request.body);
		if (!answer.success) return reply.status(400).send();
		const list = codingAgents.get(key) ?? [];
		const waiting = list.find((one) => one.terminalId === id)?.question;
		if (!waiting || waiting.id !== answer.data.id) return reply.status(409).send();
		questionAnswers.set(key, [...(questionAnswers.get(key) ?? []), answer.data]);
		const next = list.map((one) =>
			one.terminalId === id ? { ...one, question: undefined } : one,
		);
		codingAgents.set(key, next);
		if (!codingAgentsHeld.has(key)) {
			for (const socket of listeningSockets.get(key) ?? [])
				sendCodingAgents(socket, next);
		}
		return reply.status(204).send();
	});

	/** The answers forwarded for a workspace key, oldest first. */
	app.get("/__test/terminal-questions", async (request) => {
		const { key } = request.query as { key?: string };
		return { answers: questionAnswers.get(key ?? "") ?? [] };
	});

	app.get(
		"/agent-limits",
		async (request) => agentLimits.get(keyOf(request)) ?? { providers: [] },
	);

	/**
	 * Set the whole list of agent states for a workspace key and push it to
	 * the listening sockets. Each `since` defaults to now, and `subagents` to none.
	 * An entry may carry a `question` (a terminal question for the browser's card).
	 */
	app.post("/__test/coding-agents", async (request, reply) => {
		const body = (request.body ?? {}) as {
			key?: string;
			terminals?: Array<
				Omit<AgentCodingAgentStatus, "since" | "subagents"> & {
					since?: string;
					subagents?: Array<
						Omit<AgentCodingAgentStatus["subagents"][number], "since"> & {
							since?: string;
						}
					>;
				}
			>;
		};
		const key = body.key ?? "";
		const now = new Date().toISOString();
		const terminals = (body.terminals ?? []).map((one) => ({
			...one,
			since: one.since ?? now,
			subagents: (one.subagents ?? []).map((sub) => ({
				...sub,
				since: sub.since ?? now,
			})),
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
