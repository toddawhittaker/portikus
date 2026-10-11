import { GIT_TIMEOUT_MS } from "@portikus/contracts";
import type { FastifyBaseLogger, FastifyReply } from "fastify";
import type { z } from "zod";
import {
	AGENT_TIMEOUT_MS,
	type AgentClient,
	readAgentError,
	readJson,
} from "../agent-client.js";
import { sendError } from "../http.js";
import { sendAgentError } from "./project-scope.js";

/**
 * How long the agent has to answer a Git read: its own work budget plus the
 * time a healthy agent needs to hand the answer back, so the control plane
 * never gives up on a command the agent is still allowed to be running
 * (SPEC.md §12.1, §12.6).
 */
export const GIT_STATUS_BUDGET_MS = GIT_TIMEOUT_MS + AGENT_TIMEOUT_MS;
/** A diff runs two git commands, one for each side. */
export const GIT_DIFF_BUDGET_MS = GIT_TIMEOUT_MS * 2 + AGENT_TIMEOUT_MS;

/**
 * Call the agent and relay its JSON, checked against the contract. Anything
 * the contract does not accept is the agent's fault, not the student's.
 * Returns undefined after answering.
 */
export async function relayJson<T extends z.ZodTypeAny>(
	reply: FastifyReply,
	log: FastifyBaseLogger,
	agent: AgentClient,
	path: string,
	schema: T,
	signal: AbortSignal,
): Promise<z.infer<T> | undefined> {
	let response: Response;
	try {
		response = await agent.fetchRaw("GET", path, { signal });
	} catch (error) {
		sendAgentError(reply, error);
		return undefined;
	}
	if (!response.ok) {
		sendAgentError(reply, await readAgentError(response));
		return undefined;
	}
	const parsed = schema.safeParse(await readJson(response));
	if (!parsed.success) {
		// Only where the answer went wrong is logged; the values are student
		// content and never reach a log (STACK.md §15).
		log.error(
			{ issues: parsed.error.issues.map((issue) => issue.path.join(".")) },
			"the workspace agent sent an answer the contract rejected",
		);
		sendError(
			reply,
			503,
			"AGENT_UNAVAILABLE",
			"The workspace agent sent an answer we could not read.",
		);
		return undefined;
	}
	return parsed.data;
}
