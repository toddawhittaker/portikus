import type { FastifyInstance } from "fastify";
import type { AgentUsage } from "./agent-usage.js";

export interface AgentUsageRouteOptions {
	usage: AgentUsage;
}

/**
 * `GET /agent-usage`: this agent's coding-agent usage totals since it
 * started, read by the worker (ADR 0057). Token auth comes from the
 * server's own hook (SPEC.md §23.5).
 */
export async function agentUsageRoute(
	instance: FastifyInstance,
	options: AgentUsageRouteOptions,
): Promise<void> {
	instance.get("/agent-usage", async () => options.usage.report());
}
