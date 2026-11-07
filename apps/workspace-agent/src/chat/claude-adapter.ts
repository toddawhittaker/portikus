import type {
	PermissionResult,
	PermissionUpdate,
	SDKMessage,
	SDKRateLimitInfo,
} from "@anthropic-ai/claude-agent-sdk";
import {
	ChatImageMediaType,
	type ChatOpenCard,
	ChatQuestion,
	type ChatServerEvent,
	type ChatToolOutputPart,
	decodedBase64Bytes,
	MAX_CHAT_IMAGE_BYTES,
	MAX_CHAT_QUESTIONS,
	MAX_CHAT_SERVER_FRAME_BYTES,
} from "@portikus/contracts";
import { z } from "zod";

/**
 * Claude's side of the chat contract (SPEC.md §10.8): SDK messages in,
 * ChatServerEvent bodies out, and the cards `canUseTool` raises. Nothing
 * here touches a socket, so it is tested from recorded SDK frames.
 */

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
	? Omit<T, K>
	: never;

/** An event before the host stamps its session id and sequence number. */
export type ChatEventBody = DistributiveOmit<ChatServerEvent, "sessionId" | "seq">;

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

	map(message: SDKMessage): ChatEventBody[] {
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

export type ClaudeLimitWindows = Partial<
	Record<"five_hour" | "seven_day", ClaudeLimitWindow>
>;

/**
 * Utilization arrives as a fraction; Claude Code's own status line shows it
 * to one decimal place and never above 100, and so does this.
 */
function percent(utilization: number): number {
	return Math.min(Math.round(utilization * 1000) / 10, 100);
}

/**
 * The five-hour and seven-day windows a `rate_limit_event` reports, merged
 * over what was known before (SPEC.md §10.8). An event names one window, or
 * several under `unifiedWindows`.
 */
export function mergeRateLimits(
	known: ClaudeLimitWindows,
	info: SDKRateLimitInfo,
): ClaudeLimitWindows {
	const next: ClaudeLimitWindows = { ...known };
	const put = (name: unknown, utilization: unknown, resetsAt: unknown) => {
		if (name !== "five_hour" && name !== "seven_day") return;
		if (typeof utilization !== "number" || typeof resetsAt !== "number") return;
		if (!Number.isFinite(utilization) || utilization < 0) return;
		next[name] = {
			used_percentage: percent(utilization),
			resets_at: Math.floor(resetsAt),
		};
	};
	const unified = (info as { unifiedWindows?: unknown }).unifiedWindows;
	if (typeof unified === "object" && unified !== null) {
		for (const [name, window] of Object.entries(unified as Record<string, Block>)) {
			put(name, window?.utilization, window?.resetsAt);
		}
	}
	put(info.rateLimitType, info.utilization, info.resetsAt);
	return next;
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
} as const;

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
			options: [
				{ id: PERMISSION_OPTION.allowOnce, label: "Yes, go ahead" },
				{ id: PERMISSION_OPTION.deny, label: "No, keep planning" },
			],
		};
	}
	const options: { id: string; label: string }[] = [
		{ id: PERMISSION_OPTION.allowOnce, label: "Allow once" },
	];
	if ((ask.suggestions?.length ?? 0) > 0 && !ask.suppressAlwaysAllowRule) {
		options.push({ id: PERMISSION_OPTION.allowAlways, label: "Always allow" });
	}
	options.push({ id: PERMISSION_OPTION.deny, label: "Deny" });
	return {
		type: "permission",
		id: ask.toolUseID,
		toolName,
		title: ask.title ?? `Allow ${toolName}?`,
		input: shortenedInput(input),
		options,
	};
}

/** The SDK's answer for a permission card's chosen option. */
export function permissionResult(
	optionId: string,
	input: Record<string, unknown>,
	ask: ToolAsk,
): PermissionResult {
	if (optionId === PERMISSION_OPTION.allowOnce) {
		return { behavior: "allow", updatedInput: input };
	}
	if (optionId === PERMISSION_OPTION.allowAlways && ask.suggestions?.length) {
		return {
			behavior: "allow",
			updatedInput: input,
			updatedPermissions: ask.suggestions,
		};
	}
	return { behavior: "deny", message: "The user declined this tool call." };
}

/**
 * The SDK's answer for a question card, following the rules of
 * claude-agent-acp's `applyAskElicitationResponse`. The
 * browser sends one answer string per question, multi-select picks already
 * joined with ", ", and any "Other" text as that question's note. A note
 * with nothing picked is the answer; a note beside a pick rides along in
 * `annotations[question].notes`.
 */
export function questionResult(
	input: Record<string, unknown>,
	questions: readonly ChatQuestion[],
	answers: Record<string, string>,
	notes: Record<string, string> = {},
): PermissionResult {
	const picked: Record<string, string> = {};
	const annotations: Record<string, { notes: string }> = {};
	for (const { question } of questions) {
		const answer = (answers[question] ?? "").trim();
		const note = (notes[question] ?? "").trim();
		if (answer === "") {
			if (note !== "") picked[question] = note;
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
