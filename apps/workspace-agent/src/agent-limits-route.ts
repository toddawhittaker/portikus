import {
	type AgentLimitsReport,
	CODING_AGENT_LABEL,
	type CodingAgent,
	PlanUsage,
} from "@portikus/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

/** One plan limit window, such as the five-hour or the seven-day one. */
export const AgentLimitWindow = z.object({
	/** A short label for the window, such as "5h" or "7d". */
	name: z.string().min(1).max(16),
	usedPercent: z.number().min(0).max(100),
	// Bounded the same as a provider's reset time in the contract.
	resetsAt: PlanUsage.shape.resetsAt,
});
export type AgentLimitWindow = z.infer<typeof AgentLimitWindow>;

/** Most limit windows one agent reports. */
export const MAX_AGENT_LIMIT_WINDOWS = 4;

/** An agent's plan limits at the moment the workspace agent last saw them. */
export const AgentLimits = z.object({
	windows: z.array(AgentLimitWindow).max(MAX_AGENT_LIMIT_WINDOWS),
	observedAt: z.string().datetime(),
});
export type AgentLimits = z.infer<typeof AgentLimits>;

export interface AgentLimitsStoreOptions {
	/** Reads Codex's plan limits, or null when it reports none. */
	codex?: () => Promise<AgentLimits | null>;
}

/** The only window the status bar shows; the label both sources give a 7-day window. */
const PLAN_WINDOW_NAME = "7d";

/** The 7-day window as one provider's plan usage, or null when there is none. */
export function planUsage(
	id: CodingAgent,
	limits: AgentLimits | null,
): PlanUsage | null {
	const window = limits?.windows.find((one) => one.name === PLAN_WINDOW_NAME);
	if (!limits || !window) return null;
	return {
		id,
		label: CODING_AGENT_LABEL[id],
		usedPercent: window.usedPercent,
		resetsAt: window.resetsAt,
		observedAt: limits.observedAt,
	};
}

/**
 * The coding agents' plan limits as last seen. Claude Code's arrive from
 * its status line through the loopback receiver; Codex's are read on
 * demand. Memory only, and forgeable from inside the workspace, so they
 * are shown, never enforced.
 */
export class AgentLimitsStore {
	private claude: AgentLimits | null = null;
	private readonly readCodex: () => Promise<AgentLimits | null>;

	constructor(options: AgentLimitsStoreOptions = {}) {
		this.readCodex = options.codex ?? (async () => null);
	}

	setClaude(limits: AgentLimits): void {
		this.claude = limits;
	}

	/** Each provider's 7-day usage; a provider with none is left out. */
	async report(): Promise<AgentLimitsReport> {
		const providers = [
			planUsage("claude", this.claude),
			planUsage("codex", await this.readCodex()),
		].filter((usage): usage is PlanUsage => usage !== null);
		return { providers };
	}
}

export interface AgentLimitsRouteOptions {
	limits: AgentLimitsStore;
}

/**
 * `GET /agent-limits`: each provider's 7-day plan usage, read by the API for
 * the status bar. Token auth comes from the server's own hook (SPEC.md §23.5).
 */
export async function agentLimitsRoute(
	instance: FastifyInstance,
	options: AgentLimitsRouteOptions,
): Promise<void> {
	instance.get("/agent-limits", async () => options.limits.report());
}
