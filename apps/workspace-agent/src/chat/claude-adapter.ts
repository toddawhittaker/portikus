import type {
	PermissionResult,
	PermissionUpdate,
	SDKControlGetUsageResponse,
	SDKMessage,
	SDKRateLimitInfo,
	SlashCommand,
} from "@anthropic-ai/claude-agent-sdk";
import {
	type ChatCardDecision,
	ChatCommand,
	ChatImageMediaType,
	type ChatModeInfo,
	type ChatOpenCard,
	ChatQuestion,
	type ChatToolOutputPart,
	decodedBase64Bytes,
	MAX_CHAT_COMMANDS,
	MAX_CHAT_IMAGE_BYTES,
	MAX_CHAT_PLAN_CHARS,
	MAX_CHAT_QUESTIONS,
	MAX_CHAT_SERVER_FRAME_BYTES,
} from "@portikus/contracts";
import { z } from "zod";
import type { ChatEventBody } from "./agent.js";
import { alwaysAllowLabel, splitSuggestions } from "./permission-rules.js";

/**
 * Claude's side of the chat contract (SPEC.md §10.8): SDK messages in,
 * ChatServerEvent bodies out, and the cards `canUseTool` raises. Nothing
 * here touches a socket, so it is tested from recorded SDK frames.
 */

export type { ChatEventBody };

type Block = Record<string, unknown>;

function blocksOf(content: unknown): Block[] {
	if (typeof content === "string") return [{ type: "text", text: content }];
	if (!Array.isArray(content)) return [];
	return content.filter(
		(block): block is Block => typeof block === "object" && block !== null,
	);
}

function stringOf(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

/** One image block as a tool output part; anything SVG or unknown is text. */
export function imagePart(block: Block): ChatToolOutputPart {
	const source = (block.source ?? {}) as Block;
	const mediaType = ChatImageMediaType.safeParse(source.media_type);
	const data = stringOf(source.data);
	if (!mediaType.success || source.type !== "base64" || data === undefined) {
		return { type: "text", text: "[image in a format the chat does not show]" };
	}
	if (decodedBase64Bytes(data) > MAX_CHAT_IMAGE_BYTES) {
		return { type: "imageOmitted", mediaType: mediaType.data };
	}
	return { type: "image", mediaType: mediaType.data, data };
}

/** A tool result's content as output parts, in order. */
export function toolResultParts(content: unknown): ChatToolOutputPart[] {
	const parts: ChatToolOutputPart[] = [];
	for (const block of blocksOf(content)) {
		if (block.type === "text")
			parts.push({ type: "text", text: stringOf(block.text) ?? "" });
		else if (block.type === "image") parts.push(imagePart(block));
	}
	return parts;
}

/** A one-line label for a tool call, from the input fields people recognise. */
function toolTitle(name: string, input: unknown): string {
	const fields = (typeof input === "object" && input !== null ? input : {}) as Block;
	for (const key of [
		"description",
		"file_path",
		"path",
		"pattern",
		"url",
		"query",
		"command",
	]) {
		const value = stringOf(fields[key]);
		if (value) return value.length > 200 ? `${value.slice(0, 199)}…` : value;
	}
	return name;
}

/** Text joined from an assistant message's text blocks. */
function textOf(content: unknown): string {
	return blocksOf(content)
		.filter((block) => block.type === "text")
		.map((block) => stringOf(block.text) ?? "")
		.join("");
}

/** Anything JSON can carry, as the contract's `z.json()` fields expect. */
type Json = z.infer<ReturnType<typeof z.json>>;

function asJson(value: unknown): Json {
	return JSON.parse(JSON.stringify(value ?? null)) as Json;
}

/**
 * Turns the SDK's message stream into contract events. It keeps the text
 * of each assistant message seen so far, because the SDK delivers one
 * content block per frame and a `message` event carries the whole text.
 */
export class ClaudeMessageMapper {
	private readonly text = new Map<string, string>();
	/** The API message whose deltas are streaming now. */
	private streaming: string | null = null;

	/**
	 * `parent` is the Agent tool call whose subagent this maps, or null for
	 * the main conversation, where a subagent's messages stay inside its card.
	 */
	constructor(private readonly parent: string | null = null) {}

	map(message: SDKMessage): ChatEventBody[] {
		const parent =
			"parent_tool_use_id" in message ? (message.parent_tool_use_id ?? null) : null;
		if (parent !== this.parent) return [];
		switch (message.type) {
			case "stream_event":
				return this.streamEvent(message.event as unknown as Block);
			case "assistant":
				return this.assistant(message.message as unknown as Block);
			case "user":
				return this.toolResults(message.message.content);
			default:
				return [];
		}
	}

	private streamEvent(event: Block): ChatEventBody[] {
		if (event.type === "message_start") {
			const id = stringOf((event.message as Block | undefined)?.id);
			this.streaming = id ?? null;
			return [];
		}
		if (event.type !== "content_block_delta" || !this.streaming) return [];
		const delta = (event.delta ?? {}) as Block;
		if (delta.type !== "text_delta") return [];
		const text = stringOf(delta.text) ?? "";
		if (text === "") return [];
		return [{ type: "text.delta", messageId: this.streaming, text }];
	}

	private assistant(message: Block): ChatEventBody[] {
		const id = stringOf(message.id);
		if (!id) return [];
		const events: ChatEventBody[] = [];
		const added = textOf(message.content);
		if (added !== "") {
			const markdown = (this.text.get(id) ?? "") + added;
			this.text.set(id, markdown);
			events.push({ type: "message", id, role: "assistant", markdown });
		}
		for (const block of blocksOf(message.content)) {
			if (block.type !== "tool_use") continue;
			const toolId = stringOf(block.id);
			const name = stringOf(block.name);
			if (!toolId || !name) continue;
			events.push({
				type: "tool.started",
				id: toolId,
				name,
				title: toolTitle(name, block.input),
				input: shortenedInput(block.input),
			});
		}
		return events;
	}

	private toolResults(content: unknown): ChatEventBody[] {
		const events: ChatEventBody[] = [];
		for (const block of blocksOf(content)) {
			if (block.type !== "tool_result") continue;
			const id = stringOf(block.tool_use_id);
			if (!id) continue;
			for (const part of toolResultParts(block.content)) {
				events.push({ type: "tool.output", id, part });
			}
			events.push({ type: "tool.finished", id, isError: block.is_error === true });
		}
		return events;
	}
}

/** One plan-limit window as the loopback receiver's `/claude-limits` takes it. */
interface ClaudeLimitWindow {
	used_percentage: number;
	resets_at: number;
}

/** Only the seven-day window is shown; Claude has no five-hour limit now. */
export interface ClaudeLimitWindows {
	seven_day?: ClaudeLimitWindow;
}

/**
 * Utilization arrives as a fraction; Claude Code's own status line shows it
 * to one decimal place and never above 100, and so does this.
 */
function percent(utilization: number): number {
	return Math.min(Math.round(utilization * 1000) / 10, 100);
}

/**
 * The seven-day window a `rate_limit_event` reports, merged over what was
 * known before (SPEC.md §10.8). The overage-included weekly window is the
 * plan's seven-day window; other windows are not shown.
 */
export function mergeRateLimits(
	known: ClaudeLimitWindows,
	info: SDKRateLimitInfo,
): ClaudeLimitWindows {
	const { rateLimitType, utilization, resetsAt } = info;
	if (rateLimitType !== "seven_day" && rateLimitType !== "seven_day_overage_included") {
		return known;
	}
	if (typeof utilization !== "number" || typeof resetsAt !== "number") return known;
	if (!Number.isFinite(utilization) || utilization < 0) return known;
	return {
		...known,
		seven_day: {
			used_percentage: percent(utilization),
			resets_at: Math.floor(resetsAt),
		},
	};
}

/**
 * The seven-day window from the SDK's usage answer, which has the figure
 * even when no `rate_limit_event` carries one. There utilization is already
 * 0 to 100 and the reset is an ISO timestamp. Empty when plan limits do not
 * apply (an API key) or the window is missing.
 */
export function limitsFromUsage(usage: SDKControlGetUsageResponse): ClaudeLimitWindows {
	if (!usage.rate_limits_available) return {};
	const window = usage.rate_limits?.seven_day;
	if (!window) return {};
	const { utilization, resets_at: resetsAt } = window;
	if (typeof utilization !== "number" || !Number.isFinite(utilization)) return {};
	if (utilization < 0 || typeof resetsAt !== "string") return {};
	const resetsMs = Date.parse(resetsAt);
	if (Number.isNaN(resetsMs)) return {};
	return {
		seven_day: {
			used_percentage: Math.min(Math.round(utilization * 10) / 10, 100),
			resets_at: Math.floor(resetsMs / 1000),
		},
	};
}

/**
 * Commands that open a menu in the terminal and so do nothing useful in the
 * chat, where the pickers and Resume do the same job. The SDK's own
 * `terminal_slash_commands` are added to these.
 */
const MENU_COMMANDS = new Set([
	"agents",
	"config",
	"doctor",
	"exit",
	"help",
	"hooks",
	"ide",
	"login",
	"logout",
	"memory",
	"model",
	"permissions",
	"resume",
	"status",
	"terminal-setup",
	"theme",
	"vim",
]);

/**
 * The slash commands the chat lists, from the SDK's descriptions. Names that
 * do not fit the contract are dropped and the list is capped.
 */
export function chatCommands(
	commands: readonly SlashCommand[],
	terminalOnly: ReadonlySet<string> = new Set(),
): ChatCommand[] {
	const listed: ChatCommand[] = [];
	for (const command of commands) {
		const name = command.name.replace(/^\/+/, "");
		const argumentHint = command.argumentHint?.slice(0, 100) ?? "";
		const item = ChatCommand.safeParse({
			name,
			description: (command.description ?? "").slice(0, 200),
			...(argumentHint === "" ? {} : { argumentHint }),
			terminalOnly: MENU_COMMANDS.has(name) || terminalOnly.has(name),
			prefix: "/",
		});
		if (item.success && !listed.some((known) => known.name === name)) {
			listed.push(item.data);
		}
		if (listed.length === MAX_CHAT_COMMANDS) break;
	}
	return listed;
}

/**
 * Most bytes a card's input may take, so a snapshot holding many open
 * cards still fits one server frame.
 */
export const MAX_CARD_INPUT_BYTES = MAX_CHAT_SERVER_FRAME_BYTES / 32;
const SHORTENED = "… (shortened)";

function jsonBytes(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function shortenStrings(value: Json, limit: number): Json {
	if (typeof value === "string") {
		return value.length > limit ? `${value.slice(0, limit)}${SHORTENED}` : value;
	}
	if (Array.isArray(value)) return value.map((item) => shortenStrings(item, limit));
	if (value === null || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.entries(value).map(([key, item]) => [key, shortenStrings(item, limit)]),
	);
}

/**
 * A card's input for display, its long strings cut, with a visible marker,
 * until it fits MAX_CARD_INPUT_BYTES. The tool still runs on the full input.
 */
export function shortenedInput(input: unknown, maxBytes = MAX_CARD_INPUT_BYTES): Json {
	const full = asJson(input);
	let limit = Math.floor(maxBytes / 2);
	let shown = full;
	while (jsonBytes(shown) > maxBytes && limit >= 1) {
		shown = shortenStrings(full, limit);
		limit = Math.floor(limit / 2);
	}
	return shown;
}

/** The ids the permission card's buttons carry. */
export const PERMISSION_OPTION = {
	allowOnce: "allow",
	allowAlways: "always",
	deny: "deny",
	/** Plan approval, continuing in acceptEdits mode. */
	planAcceptEdits: "allow-accept-edits",
	/** Plan approval, continuing in default mode. */
	planAskEdits: "allow-ask-edits",
} as const;

/**
 * The fixed word for a permission option. Approving a plan counts as
 * "allowed" and keeping planning as "denied"; the card's tool tells a reader
 * which kind of card it was.
 */
export function decisionForOption(optionId: string): ChatCardDecision {
	if (optionId === PERMISSION_OPTION.allowAlways) return "allowedAlways";
	if (optionId === PERMISSION_OPTION.deny) return "denied";
	return "allowed";
}

/** A permission card's button, saying which decision it is (SPEC.md §10.8). */
function button(id: string, label: string) {
	return { id, label, decision: decisionForOption(id) };
}

/** The mode each plan approval option continues in. */
const PLAN_OPTION_MODE: Record<string, "acceptEdits" | "default"> = {
	[PERMISSION_OPTION.planAcceptEdits]: "acceptEdits",
	[PERMISSION_OPTION.planAskEdits]: "default",
};

/** What `canUseTool` gives the host besides the tool's name and input. */
export interface ToolAsk {
	toolUseID: string;
	title?: string;
	suggestions?: PermissionUpdate[];
	suppressAlwaysAllowRule?: boolean;
}

const QuestionInput = z.object({
	questions: z.array(ChatQuestion).min(1).max(MAX_CHAT_QUESTIONS),
});

/**
 * The card a tool call raises. AskUserQuestion becomes a question card when
 * its input fits the contract; anything else, a question that does not fit
 * included, becomes a permission card. ExitPlanMode's card holds the plan.
 */
export function cardForTool(
	toolName: string,
	input: Record<string, unknown>,
	ask: ToolAsk,
): ChatOpenCard {
	if (toolName === "AskUserQuestion") {
		const parsed = QuestionInput.safeParse(input);
		if (parsed.success) {
			return { type: "question", id: ask.toolUseID, questions: parsed.data.questions };
		}
	}
	if (toolName === "ExitPlanMode") {
		return {
			type: "permission",
			id: ask.toolUseID,
			toolName,
			title: "Claude has a plan. Start working on it?",
			input: shortenedInput(input),
			...(typeof input.plan === "string"
				? { plan: input.plan.slice(0, MAX_CHAT_PLAN_CHARS) }
				: {}),
			options: [
				button(PERMISSION_OPTION.planAcceptEdits, "Yes, and accept edits"),
				button(PERMISSION_OPTION.planAskEdits, "Yes, and ask before edits"),
				button(PERMISSION_OPTION.deny, "No, keep planning"),
			],
		};
	}
	const options = [button(PERMISSION_OPTION.allowOnce, "Allow once")];
	if (ask.suggestions && ask.suggestions.length > 0 && !ask.suppressAlwaysAllowRule) {
		options.push(
			button(PERMISSION_OPTION.allowAlways, alwaysAllowLabel(ask.suggestions)),
		);
	}
	options.push(button(PERMISSION_OPTION.deny, "Deny"));
	return {
		type: "permission",
		id: ask.toolUseID,
		toolName,
		title: ask.title ?? `Allow ${toolName}?`,
		input: shortenedInput(input),
		options,
	};
}

/** What the student added to a permission answer. */
export interface PermissionAnswerExtras {
	/** Why the student denied, or what to plan instead. */
	message?: string | undefined;
}

/**
 * The SDK's answer for a permission card's chosen option. Session allow
 * rules are left out of `updatedPermissions`: the host grants those itself
 * so they can be revoked.
 */
export function permissionResult(
	optionId: string,
	input: Record<string, unknown>,
	ask: ToolAsk,
	extras: PermissionAnswerExtras = {},
): PermissionResult {
	const planMode = PLAN_OPTION_MODE[optionId];
	if (planMode) {
		// The session continues in the chosen mode; the host's status event updates the picker.
		return {
			behavior: "allow",
			updatedInput: input,
			updatedPermissions: [{ type: "setMode", mode: planMode, destination: "session" }],
		};
	}
	if (optionId === PERMISSION_OPTION.allowOnce) {
		return { behavior: "allow", updatedInput: input };
	}
	if (optionId === PERMISSION_OPTION.allowAlways && ask.suggestions?.length) {
		const { forSdk } = splitSuggestions(ask.suggestions);
		return {
			behavior: "allow",
			updatedInput: input,
			...(forSdk.length > 0 ? { updatedPermissions: forSdk } : {}),
		};
	}
	const reason = extras.message?.trim();
	return { behavior: "deny", message: reason || "The user declined this tool call." };
}

/** The init capability that lets an answer mark a question skipped; older CLIs refuse the mark. */
export const UNANSWERED_CAPABILITY = "ask_user_question_unanswered_v1";

/**
 * The SDK's answer for a question card, following the rules of
 * claude-agent-acp's `applyAskElicitationResponse`. The
 * browser sends one answer string per question, multi-select picks already
 * joined with ", ", and any "Other" text as that question's note. A note
 * with nothing picked is the answer; a note beside a pick rides along in
 * `annotations[question].notes`. A question with neither was skipped; when
 * `reportSkipped` is set it is marked `unanswered: "skipped"`, which only a
 * session advertising {@link UNANSWERED_CAPABILITY} accepts.
 */
export function questionResult(
	input: Record<string, unknown>,
	questions: readonly ChatQuestion[],
	answers: Record<string, string>,
	notes: Record<string, string> = {},
	reportSkipped = false,
): { behavior: "allow"; updatedInput: Record<string, unknown> } {
	const picked: Record<string, string> = {};
	const annotations: Record<string, { notes?: string; unanswered?: "skipped" }> = {};
	for (const { question } of questions) {
		const answer = (answers[question] ?? "").trim();
		const note = (notes[question] ?? "").trim();
		if (answer === "") {
			if (note !== "") picked[question] = note;
			else if (reportSkipped) annotations[question] = { unanswered: "skipped" };
			continue;
		}
		picked[question] = answer;
		if (note !== "") annotations[question] = { notes: note };
	}
	return {
		behavior: "allow",
		updatedInput: {
			...input,
			answers: picked,
			...(Object.keys(annotations).length > 0 ? { annotations } : {}),
		},
	};
}

/**
 * The five permission modes Claude offers, in the picker's order, with the
 * wording the student reads (SPEC.md §10.8). Bypass warns; Plan plans.
 */
export const CLAUDE_MODES: readonly ChatModeInfo[] = [
	{
		id: "default",
		label: "Ask",
		description: "Asks before it edits files or runs commands.",
		warning: false,
		plan: false,
	},
	{
		id: "acceptEdits",
		label: "Accept edits",
		description: "Edits files on its own. Asks before commands.",
		warning: false,
		plan: false,
	},
	{
		id: "plan",
		label: "Plan",
		description: "Reads and plans. Changes nothing.",
		warning: false,
		plan: true,
	},
	{
		id: "auto",
		label: "Auto",
		description: "Runs what it judges safe. Asks about the rest.",
		warning: false,
		plan: false,
	},
	{
		id: "bypassPermissions",
		label: "Bypass permissions",
		description:
			"Bypass permissions lets Claude run every tool without asking you first.",
		warning: true,
		plan: false,
	},
];
