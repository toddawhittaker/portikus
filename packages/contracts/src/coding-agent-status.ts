import { z } from "zod";
import { AgentUsageCounts } from "./agent-usage.js";
import { CodingAgent, TerminalId } from "./terminal.js";

/**
 * What a Claude Code or Codex terminal is doing, and the plan limits of each
 * agent. The signals come from the agents' own hooks and status line, never
 * from reading terminal output. The student's own agents send them, so they
 * drive the student's screen only and nothing is stored or enforced.
 */

/** Working, waiting for the student, or done with its turn. */
export const CodingAgentState = z.enum(["working", "needs-input", "finished"]);
export type CodingAgentState = z.infer<typeof CodingAgentState>;

/** Most terminals one workspace reports; a student has a handful of agents. */
export const MAX_CODING_AGENT_TERMINALS = 20;

const CodingAgentStatusFields = {
	terminalId: TerminalId,
	agent: CodingAgent,
	state: CodingAgentState,
	/** When the terminal entered this state. */
	since: z.string().datetime(),
};

/** One terminal's agent state, as the workspace agent reports it. */
export const AgentCodingAgentStatus = z.object(CodingAgentStatusFields);
export type AgentCodingAgentStatus = z.infer<typeof AgentCodingAgentStatus>;

/** The frame the workspace agent sends on the listening socket when any state changes. */
export const AgentCodingAgentsChanged = z.object({
	type: z.literal("workspace.coding-agents.changed"),
	terminals: z.array(AgentCodingAgentStatus).max(MAX_CODING_AGENT_TERMINALS),
});
export type AgentCodingAgentsChanged = z.infer<typeof AgentCodingAgentsChanged>;

/** One terminal's agent state as the browser gets it, with its project. */
export const CodingAgentTerminal = z.object({
	...CodingAgentStatusFields,
	projectId: z.string().uuid(),
});
export type CodingAgentTerminal = z.infer<typeof CodingAgentTerminal>;

/** How far ahead a limit may reset; a plan window is at most a week or so. */
export const MAX_LIMIT_RESET_DAYS = 31;

/** One plan limit window, such as the five-hour or the seven-day one. */
export const AgentLimitWindow = z.object({
	/** A short label for the window, such as "5h" or "7d". */
	name: z.string().min(1).max(16),
	usedPercent: z.number().min(0).max(100),
	resetsAt: z
		.string()
		.datetime()
		.refine((at) => Date.parse(at) <= Date.now() + MAX_LIMIT_RESET_DAYS * 86_400_000, {
			message: `must be within ${MAX_LIMIT_RESET_DAYS} days`,
		}),
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

/** The workspace agent's `GET /agent-limits`; null when an agent reports none. */
export const AgentLimitsReport = z.object({
	claude: AgentLimits.nullable(),
	codex: AgentLimits.nullable(),
});
export type AgentLimitsReport = z.infer<typeof AgentLimitsReport>;

/**
 * Response body of `GET /workspaces/:id/agent-meter`. `limits` is null when
 * the agent reports none or cannot be reached; `today` is the student's own
 * counts for the current UTC day, null when there are none.
 */
export const AgentMeter = z.object({
	agents: z.array(
		z.object({
			agent: CodingAgent,
			limits: AgentLimits.nullable(),
			today: AgentUsageCounts.nullable(),
		}),
	),
});
export type AgentMeter = z.infer<typeof AgentMeter>;
