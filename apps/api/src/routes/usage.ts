import { WorkspaceUsage } from "@portikus/contracts";
import type { FastifyInstance } from "fastify";
import { AGENT_TIMEOUT_MS, readAgentError, readJson } from "../agent-client.js";
import type { ServerDeps } from "../server.js";
import {
	ownedScope,
	requireAgent,
	sendAgentError,
	sendError,
} from "./project-scope.js";

/**
 * The workspace's CPU, memory, disk, network and processes (SPEC.md §18.2,
 * §18.3). Proxied like the listening list: only the owner gets through, and
 * the browser never reaches the agent. The sample and its command names are
 * not logged (STACK.md §15).
 */
export function registerUsageRoutes(app: FastifyInstance, deps: ServerDeps): void {
	const { db, config } = deps;

	app.get("/workspaces/:id/usage", async (request, reply) => {
		const scope = await ownedScope(db, config, request, reply);
		if (!scope) return;
		const agent = requireAgent(scope, reply);
		if (!agent) return;
		let response: Response;
		try {
			response = await agent.fetchRaw("GET", "/usage", {
				signal: AbortSignal.timeout(AGENT_TIMEOUT_MS),
			});
		} catch (error) {
			return sendAgentError(reply, error);
		}
		if (!response.ok) return sendAgentError(reply, await readAgentError(response));
		const parsed = WorkspaceUsage.safeParse(await readJson(response));
		if (!parsed.success) {
			// Paths only. The sample itself names processes and is never logged.
			request.log.error(
				{ issues: parsed.error.issues.map((issue) => issue.path.join(".")) },
				"the workspace agent sent usage the contract rejected",
			);
			return sendError(
				reply,
				503,
				"AGENT_UNAVAILABLE",
				"The workspace agent sent an answer we could not read.",
			);
		}
		return parsed.data;
	});
}
