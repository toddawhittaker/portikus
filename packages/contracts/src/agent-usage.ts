import { z } from "zod";
import { CodingAgent } from "./terminal.js";

/**
 * Coding-agent usage counts (SPEC.md §25.10, ADR 0057). Counts only, never
 * prompts, code or session ids. The student's own agents report them, so
 * they are for reporting, never enforcement.
 */

/** Longest model name kept; the database checks the same bound. */
export const MAX_AGENT_USAGE_MODEL_LENGTH = 100;

/** Most models the receiver keeps per UTC day; later ones are dropped. */
export const MAX_AGENT_USAGE_MODELS_PER_DAY = 50;

/** Days of usage kept; the worker prunes older rows daily. */
export const AGENT_USAGE_RETENTION_DAYS = 365;

/**
 * Most rows one report may carry: two agents at the model cap for 40
 * days, more than a workspace agent stays up between restarts.
 */
export const MAX_AGENT_USAGE_REPORT_ROWS = 2 * MAX_AGENT_USAGE_MODELS_PER_DAY * 40;

/** A model name as the agent tool reports it: printable ASCII, no spaces. */
export const AgentUsageModel = z
	.string()
	.min(1)
	.max(MAX_AGENT_USAGE_MODEL_LENGTH)
	.regex(/^[\x21-\x7e]+$/);

/** A UTC day, YYYY-MM-DD. */
export const UsageDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const Count = z.number().int().nonnegative();

/** The counters kept for one day, agent and model. */
export const AgentUsageCounts = z.object({
	sessions: Count,
	inputTokens: Count,
	outputTokens: Count,
	cacheReadTokens: Count,
	cacheWriteTokens: Count,
	/** Claude Code's estimate at API prices; null when the agent reports none. */
	costUsd: z.number().nonnegative().nullable(),
	linesAdded: Count,
	linesRemoved: Count,
});
export type AgentUsageCounts = z.infer<typeof AgentUsageCounts>;

/** One report row: running totals since the agent started, for one day, agent and model. */
export const AgentUsageReportRow = AgentUsageCounts.extend({
	day: UsageDay,
	agent: CodingAgent,
	model: AgentUsageModel,
});
export type AgentUsageReportRow = z.infer<typeof AgentUsageReportRow>;

/**
 * The workspace agent's `GET /agent-usage`, read by the worker. `bootId` is
 * picked at agent start; the worker upserts each row under it, so a repeated
 * read overwrites rather than adds.
 */
export const AgentUsageReport = z.object({
	bootId: z.string().uuid(),
	rows: z.array(AgentUsageReportRow).max(MAX_AGENT_USAGE_REPORT_ROWS),
});
export type AgentUsageReport = z.infer<typeof AgentUsageReport>;

/** The windows the usage views offer, in days. */
export const AgentUsageWindow = z.union([z.literal(7), z.literal(30), z.literal(90)]);
export type AgentUsageWindow = z.infer<typeof AgentUsageWindow>;

/** Query for both usage views: `?days=7|30|90`, 7 when absent. */
export const AgentUsageQuery = z.object({
	days: z.enum(["7", "30", "90"]).default("7").transform(Number).pipe(AgentUsageWindow),
});
export type AgentUsageQuery = z.infer<typeof AgentUsageQuery>;

/** One person's totals for one agent over the window, summed across boots. */
export const AgentUsageUserTotal = AgentUsageCounts.extend({
	userId: z.string().uuid(),
	displayName: z.string().min(1),
	agent: CodingAgent,
});
export type AgentUsageUserTotal = z.infer<typeof AgentUsageUserTotal>;

/** Everyone's totals for one day and agent. */
export const AgentUsageDailyTotal = AgentUsageCounts.extend({
	day: UsageDay,
	agent: CodingAgent,
});
export type AgentUsageDailyTotal = z.infer<typeof AgentUsageDailyTotal>;

/**
 * Response body for `GET /courses/:courseId/agent-usage` (the course's
 * members, including their use outside it) and `GET /admin/agent-usage`
 * (everyone).
 */
export const AgentUsageResponse = z.object({
	days: AgentUsageWindow,
	/** First and last UTC day of the window, inclusive. */
	from: UsageDay,
	to: UsageDay,
	users: z.array(AgentUsageUserTotal),
	daily: z.array(AgentUsageDailyTotal),
});
export type AgentUsageResponse = z.infer<typeof AgentUsageResponse>;
