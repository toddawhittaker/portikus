import { z } from "zod";
import { AgentUsageCounts } from "./agent-usage.js";
import { CodingAgent, TerminalId, TerminalKind } from "./terminal.js";

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

/** Most subagent rows one terminal reports; finished rows are dropped first. */
export const MAX_SUBAGENTS_PER_TERMINAL = 16;

/** An Agent tool call id, which is also the chat's tool row id. */
const ToolCallId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

/** One subagent an agent started: working until it returns, then finished. */
export const CodingAgentSubagent = z.object({
	id: ToolCallId,
	type: z.string().min(1).max(64),
	description: z.string().max(120),
	state: z.enum(["working", "finished"]),
	since: z.string().datetime(),
});
export type CodingAgentSubagent = z.infer<typeof CodingAgentSubagent>;

const CodingAgentStatusFields = {
	terminalId: TerminalId,
	agent: CodingAgent,
	state: CodingAgentState,
	/** When the terminal entered this state. */
	since: z.string().datetime(),
	subagents: z.array(CodingAgentSubagent).max(MAX_SUBAGENTS_PER_TERMINAL).default([]),
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
	/** The terminal's tab name, joined by the API. */
	name: z.string().min(1).max(64),
	/** A chat or a terminal tab, joined by the API so the row is labelled as its tab is. */
	kind: TerminalKind.default("terminal"),
});
export type CodingAgentTerminal = z.infer<typeof CodingAgentTerminal>;

/** The hook events the subagent route takes. */
const CodingAgentSubagentEvent = z.enum([
	"pre_tool_use",
	"post_tool_use",
	"post_tool_use_failure",
	"subagent_stop",
	"user_prompt_submit",
	"stop",
]);

/** Longest subagent description kept. */
export const MAX_SUBAGENT_DESCRIPTION_CHARS = 120;

/** Longest subagent type kept; a plugin's agent type may be longer. */
const MAX_SUBAGENT_TYPE_CHARS = 64;

/** Trim, then cut to `max` characters without splitting one made of two code units. */
function cutText(text: string, max: number): string {
	return Array.from(text.trim()).slice(0, max).join("").trim();
}

/**
 * A hook's report to `POST /coding-agent-subagent`. Only the allow-listed
 * fields travel, never the prompt. A long description or type is cut to fit
 * rather than refused, so the row still appears.
 */
export const CodingAgentSubagentPost = z
	.object({
		terminal: TerminalId,
		event: CodingAgentSubagentEvent,
		/** When the hook fired, in microseconds since the epoch; orders late posts per row. */
		at: z.number().int().positive(),
		tool_use_id: ToolCallId.optional(),
		description: z
			.string()
			.transform((text) => cutText(text, MAX_SUBAGENT_DESCRIPTION_CHARS))
			.optional(),
		// Blanks alone leave no type, so the board falls back to its default.
		subagent_type: z
			.string()
			.min(1)
			.transform((text) => cutText(text, MAX_SUBAGENT_TYPE_CHARS) || undefined)
			.optional(),
		agent_id: z.string().min(1).max(128).optional(),
		run_in_background: z.boolean().optional(),
	})
	.strict();
export type CodingAgentSubagentPost = z.infer<typeof CodingAgentSubagentPost>;

/** How far ahead a limit may reset; a plan window is at most a week or so. */
export const MAX_LIMIT_RESET_DAYS = 31;

const ResetsAt = z
	.string()
	.datetime()
	.refine((at) => Date.parse(at) <= Date.now() + MAX_LIMIT_RESET_DAYS * 86_400_000, {
		message: `must be within ${MAX_LIMIT_RESET_DAYS} days`,
	});

/** Most providers one limits report or meter lists. */
const MAX_PLAN_PROVIDERS = 8;

const ProviderId = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/);
const ProviderLabel = z.string().min(1).max(32);

/** One provider's seven-day plan usage. The id is the agent id, so later providers plug in. */
export const PlanUsage = z.object({
	id: ProviderId,
	label: ProviderLabel,
	usedPercent: z.number().min(0).max(100),
	resetsAt: ResetsAt,
	observedAt: z.string().datetime(),
});
export type PlanUsage = z.infer<typeof PlanUsage>;

/** The workspace agent's `GET /agent-limits`; a provider that reports nothing is left out. */
export const AgentLimitsReport = z.object({
	providers: z.array(PlanUsage).max(MAX_PLAN_PROVIDERS),
});
export type AgentLimitsReport = z.infer<typeof AgentLimitsReport>;

/**
 * Response body of `GET /workspaces/:id/agent-meter`. `plan` is null when the
 * provider reports no plan usage or cannot be reached; `today` is the
 * student's own counts for the current UTC day, null when there are none.
 */
export const AgentMeter = z.object({
	providers: z
		.array(
			z.object({
				id: ProviderId,
				label: ProviderLabel,
				plan: PlanUsage.nullable(),
				today: AgentUsageCounts.nullable(),
			}),
		)
		.max(MAX_PLAN_PROVIDERS),
});
export type AgentMeter = z.infer<typeof AgentMeter>;
