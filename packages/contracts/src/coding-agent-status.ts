import { z } from "zod";
import { AgentUsageCounts } from "./agent-usage.js";
import { ChatQuestion, MAX_AGENT_TITLE_CHARS, MAX_CHAT_QUESTIONS } from "./chat.js";
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

/**
 * A title as shown: control characters (line breaks among them) and
 * invisible format characters (bidi overrides, zero-width marks) become
 * spaces (except the zero-width joiner, which holds emoji such as 👩‍💻
 * together), runs of space close up, and the text is cut to fit without
 * splitting a character made of two code units. Empty when nothing is left.
 */
export function agentTitleText(raw: string): string {
	const flat = raw
		.replace(/(?!\u200D)[\p{Cc}\p{Cf}]/gu, " ")
		.replace(/\s+/g, " ")
		.trim();
	let cut = "";
	for (const char of flat) {
		if (cut.length + char.length > MAX_AGENT_TITLE_CHARS) break;
		cut += char;
	}
	return cut.trim();
}

/**
 * A chat's conversation title, from Claude Code's session file. It is drawn
 * from the student's prompts, so it is shown and never logged (ADR 0074).
 */
const AgentTitle = z.string().min(1).max(MAX_AGENT_TITLE_CHARS);

/** How long a terminal question waits for an answer before Claude Code asks in the terminal. */
export const TERMINAL_QUESTION_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Largest hook post body the receiver takes, in bytes of its JSON. A forged
 * post to the loopback port cannot make the agent hold more than this.
 */
export const MAX_TERMINAL_QUESTION_POST_BYTES = 64 * 1024;

/** Longest answer, note or tool name in these bodies; the post cap bounds the sum. */
const MAX_TERMINAL_QUESTION_TEXT_CHARS = 16 * 1024;

/** Longest question, option label, description or preview a terminal question carries. */
export const MAX_TERMINAL_QUESTION_STRING_CHARS = 4 * 1024;

/**
 * Most bytes of question JSON the workspace agent holds across all its
 * terminals, so the coding-agents frame stays well under the API's 1 MiB
 * frame cap. A question past it is asked in the terminal instead.
 */
export const MAX_TERMINAL_QUESTIONS_HELD_BYTES = 512 * 1024;

const fitsString = (text: string | undefined) =>
	(text ?? "").length <= MAX_TERMINAL_QUESTION_STRING_CHARS;

/** A chat question with every string capped; the chat's own are bounded by its frame. */
const TerminalChatQuestion = ChatQuestion.refine(
	(item) =>
		fitsString(item.question) &&
		item.options.every(
			(option) =>
				fitsString(option.label) &&
				fitsString(option.description) &&
				fitsString(option.preview),
		),
	{
		message: `strings must be at most ${MAX_TERMINAL_QUESTION_STRING_CHARS} characters`,
	},
);

/** The questions an AskUserQuestion call may carry for a terminal's card. */
export const TerminalChatQuestions = z
	.array(TerminalChatQuestion)
	.min(1)
	.max(MAX_CHAT_QUESTIONS);

/**
 * The question a terminal's Claude Code is waiting on, shaped as the chat's
 * question card takes it. The id is the AskUserQuestion tool call id.
 */
export const TerminalQuestion = z
	.object({
		id: ToolCallId,
		questions: TerminalChatQuestions,
	})
	.strict();
export type TerminalQuestion = z.infer<typeof TerminalQuestion>;

/** Answers and notes are keyed by the question text, as the chat's are. */
const AnswerMap = z
	.record(
		z.string().min(1).max(MAX_TERMINAL_QUESTION_TEXT_CHARS),
		z.string().max(MAX_TERMINAL_QUESTION_TEXT_CHARS),
	)
	.refine((map) => Object.keys(map).length <= MAX_CHAT_QUESTIONS, {
		message: "too many entries",
	});

/**
 * The browser's answer to a terminal question, which the API forwards to the
 * agent: picked answers (with optional per-question notes, as in the chat's
 * `question.answer`), or "answer in the terminal" so Claude Code asks itself.
 */
export const TerminalQuestionAnswer = z.union([
	z
		.object({
			id: ToolCallId,
			answers: AnswerMap,
			notes: AnswerMap.optional(),
		})
		.strict(),
	z.object({ id: ToolCallId, inTerminal: z.literal(true) }).strict(),
]);
export type TerminalQuestionAnswer = z.infer<typeof TerminalQuestionAnswer>;

/**
 * A hook's post to the loopback receiver: the three fields it keeps from the
 * PreToolUse event. `tool_input` is checked by the receiver against the
 * question shape; here it only has to be JSON that fits the byte cap.
 */
export const TerminalQuestionPost = z
	.object({
		tool_name: z.string().min(1).max(MAX_TERMINAL_QUESTION_TEXT_CHARS),
		tool_use_id: ToolCallId,
		tool_input: z.unknown(),
	})
	.strict()
	.refine(
		(body) =>
			new TextEncoder().encode(JSON.stringify(body) ?? "").length <=
			MAX_TERMINAL_QUESTION_POST_BYTES,
		{ message: `must be at most ${MAX_TERMINAL_QUESTION_POST_BYTES} bytes` },
	);
export type TerminalQuestionPost = z.infer<typeof TerminalQuestionPost>;

const CodingAgentStatusFields = {
	terminalId: TerminalId,
	agent: CodingAgent,
	state: CodingAgentState,
	/** When the terminal entered this state. */
	since: z.string().datetime(),
	subagents: z.array(CodingAgentSubagent).max(MAX_SUBAGENTS_PER_TERMINAL).default([]),
	/** A chat tab's conversation title; terminal tabs have none. */
	title: AgentTitle.optional(),
	/** Set while the agent waits on a question the student can answer in the browser. */
	question: TerminalQuestion.optional(),
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
	"subagent_start",
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
 * rather than refused, so the row still appears. A subagent start (Codex
 * names no tool call) is keyed by its agent id, which becomes the row's id,
 * so it must fit one.
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
	.strict()
	.refine(
		(post) =>
			post.event !== "subagent_start" ||
			(post.agent_id !== undefined && ToolCallId.safeParse(post.agent_id).success),
		{
			message: "a subagent start needs an agent id that fits a row id",
			path: ["agent_id"],
		},
	);
export type CodingAgentSubagentPost = z.infer<typeof CodingAgentSubagentPost>;

/**
 * A chat host's report to `POST /coding-agent-title`: the conversation's
 * title, or null when it has none yet. The title is cleaned on arrival.
 */
export const CodingAgentTitlePost = z
	.object({
		terminal: TerminalId,
		title: z
			.string()
			.max(4 * MAX_AGENT_TITLE_CHARS)
			.transform((text) => agentTitleText(text) || null)
			.nullable(),
	})
	.strict();
export type CodingAgentTitlePost = z.infer<typeof CodingAgentTitlePost>;

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
