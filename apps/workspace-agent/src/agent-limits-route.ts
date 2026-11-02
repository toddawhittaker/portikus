import type { AgentLimits, AgentLimitsReport } from "@portikus/contracts";
import type { FastifyInstance } from "fastify";

export interface AgentLimitsStoreOptions {
	/** Reads Codex's plan limits, or null when it reports none. */
	codex?: () => Promise<AgentLimits | null>;
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

	async report(): Promise<AgentLimitsReport> {
		return { claude: this.claude, codex: await this.readCodex() };
	}
}

export interface AgentLimitsRouteOptions {
	limits: AgentLimitsStore;
}

/**
 * `GET /agent-limits`: each coding agent's plan limits, read by the API for
 * the status bar. Token auth comes from the server's own hook (SPEC.md §23.5).
 */
export async function agentLimitsRoute(
	instance: FastifyInstance,
	options: AgentLimitsRouteOptions,
): Promise<void> {
	instance.get("/agent-limits", async () => options.limits.report());
}
