import { requireUser } from "@portikus/auth";
import {
	CodingAgent,
	LegacyAgentLimitsReport,
	type LegacyAgentMeter,
} from "@portikus/contracts";
import type { FastifyInstance } from "fastify";
import { AGENT_TIMEOUT_MS, readJson } from "../agent-client.js";
import type { ServerDeps } from "../deps.js";
import { ownedScope } from "../workspaces/project-scope.js";
import { todayUsageFor } from "./agent-usage.js";

const AGENTS = CodingAgent.options;

/**
 * Each coding agent's plan limits and today's counts for the status bar
 * (SPEC.md §25.10). Owner only: an administrator gets the same 404 as for
 * any other workspace route. Limits come from the workspace agent and are
 * null when it cannot be reached or answers badly, because the counts are
 * still worth showing. Nothing the agent sends is logged beyond field names
 * (STACK.md §15).
 */
export function registerAgentMeterRoutes(app: FastifyInstance, deps: ServerDeps): void {
	const { db, config } = deps;

	app.get("/workspaces/:id/agent-meter", async (request, reply) => {
		const scope = await ownedScope(db, config, request, reply);
		if (!scope) return;
		const user = requireUser(request);

		let report: LegacyAgentLimitsReport | null = null;
		if (scope.agent) {
			try {
				const response = await scope.agent.fetchRaw("GET", "/agent-limits", {
					signal: AbortSignal.timeout(AGENT_TIMEOUT_MS),
				});
				if (response.ok) {
					const parsed = LegacyAgentLimitsReport.safeParse(await readJson(response));
					if (parsed.success) report = parsed.data;
					else {
						request.log.warn(
							{ fields: parsed.error.issues.map((issue) => issue.path.join(".")) },
							"the workspace agent sent limits the contract rejected",
						);
					}
				}
			} catch {
				// An unreachable agent leaves the limits out; the counts still show.
			}
		}

		const today = await todayUsageFor(db, user.id, new Date());
		const meter: LegacyAgentMeter = {
			agents: AGENTS.map((agent) => ({
				agent,
				limits: report?.[agent] ?? null,
				today: today[agent],
			})),
		};
		return meter;
	});
}
