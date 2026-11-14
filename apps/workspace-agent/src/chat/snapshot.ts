import type { SDKMessage, SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import {
	MAX_CHAT_SERVER_FRAME_BYTES,
	MAX_CHAT_SHELL_COMMAND_CHARS,
	MAX_CHAT_SHELL_OUTPUT_CHARS,
} from "@portikus/contracts";
import { splitAttachmentLines } from "./attachments.js";
import { type ChatEventBody, ClaudeMessageMapper } from "./claude-adapter.js";
import { splitHandoff } from "./handoff.js";
import { parseBashInput, parseBashOutput } from "./shell-command.js";
import { REPLAY_TURNS } from "./wire.js";

/** Only the newest turns keep their tool images on replay. */
export const REPLAY_IMAGE_TURNS = 5;
/** Room for the session id and sequence number the host stamps on. */
const ENVELOPE_BYTES = 128;

type Block = Record<string, unknown>;
type TurnStatus = "done" | "interrupted" | "error";

/** Fields Claude Code writes on transcript entries that the SDK type leaves out. */
interface EntryExtras {
	timestamp?: string;
	is_meta?: boolean;
	isCompletedLocalCommand?: boolean;
	origin?: { kind?: string };
}

/** What Claude Code writes when the student interrupts a turn. */
const INTERRUPT_MARKER = /^\[Request interrupted by user[^\]]*\]$/;

function extras(entry: SessionMessage): EntryExtras {
	return entry as unknown as EntryExtras;
}

/** The text of a user entry that holds no tool result, else null. */
function plainText(entry: SessionMessage | undefined): string | null {
	if (entry?.type !== "user") return null;
	const content = ((entry.message ?? {}) as Block).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return null;
	const blocks = content as Block[];
	if (blocks.some((block) => block?.type === "tool_result")) return null;
	return blocks
		.filter((block) => block?.type === "text" && typeof block.text === "string")
		.map((block) => block.text as string)
		.join("");
}

/** The text of a top-level user entry that holds no tool result, else null. */
function userText(entry: SessionMessage): string | null {
	return entry.parent_tool_use_id === null ? plainText(entry) : null;
}

function isInterruptMarker(entry: SessionMessage): boolean {
	const text = userText(entry);
	return text !== null && INTERRUPT_MARKER.test(text.trim());
}

/** A `!` command's transcript entry: its input, or its output. */
function isShellEntry(entry: SessionMessage | undefined): boolean {
	const text = entry ? userText(entry) : null;
	return (
		text !== null && (parseBashInput(text) !== null || parseBashOutput(text) !== null)
	);
}

/** A `!` command's input entry and the output entry after it, as one shell item. */
function shellEvents(group: readonly SessionMessage[]): ChatEventBody[] {
	const [input, result] = group;
	const command = parseBashInput((input && userText(input)) ?? "");
	const output = parseBashOutput((result && userText(result)) ?? "");
	if (!input || command === null || output === null) return [];
	return [
		{
			type: "shell",
			id: input.uuid,
			command: command.slice(0, MAX_CHAT_SHELL_COMMAND_CHARS),
			output: output.output.slice(0, MAX_CHAT_SHELL_OUTPUT_CHARS),
			exitCode: output.exitCode,
			truncated: output.truncated || output.output.length > MAX_CHAT_SHELL_OUTPUT_CHARS,
			state: "done",
		},
	];
}

/**
 * A message the student typed. Claude Code also writes user entries of its
 * own (interrupt markers, local command echoes, task notifications); those
 * are not shown. An image-only message has no text and still counts.
 */
function isTyped(entry: SessionMessage): boolean {
	if (userText(entry) === null || isInterruptMarker(entry) || isShellEntry(entry))
		return false;
	const { is_meta, isCompletedLocalCommand, origin } = extras(entry);
	if (is_meta || isCompletedLocalCommand) return false;
	return origin?.kind === undefined || origin.kind === "human";
}

/** Claude Code records a failed API call as a synthetic assistant message. */
function isApiError(entry: SessionMessage): boolean {
	const message = (entry.message ?? {}) as Block;
	return entry.type === "assistant" && message.model === "<synthetic>";
}

function timeOf(entry: SessionMessage | undefined, fallback: number): number {
	const parsed = Date.parse(extras(entry ?? ({} as SessionMessage)).timestamp ?? "");
	return Number.isNaN(parsed) ? fallback : parsed;
}

function statusOf(turn: readonly SessionMessage[]): TurnStatus {
	if (turn.some(isInterruptMarker)) return "interrupted";
	const last = [...turn].reverse().find((entry) => entry.type === "assistant");
	return last && isApiError(last) ? "error" : "done";
}

function fits(event: ChatEventBody, maxBytes: number): boolean {
	return Buffer.byteLength(JSON.stringify(event), "utf8") + ENVELOPE_BYTES <= maxBytes;
}

/** One transcript entry as replayed events, or none for an entry not shown. */
function entryEvents(
	entry: SessionMessage,
	mapper: ClaudeMessageMapper,
	keepImages: boolean,
	maxBytes: number,
): ChatEventBody[] {
	if (isTyped(entry)) {
		const { text, attachments } = splitAttachmentLines(
			splitHandoff(userText(entry) ?? "").text,
		);
		return [
			{
				type: "message",
				id: entry.uuid,
				role: "user",
				markdown: text,
				...(attachments.length > 0 ? { attachments } : {}),
			},
		];
	}
	const toolResults = entry.type === "user" && userText(entry) === null;
	if ((entry.type !== "assistant" && !toolResults) || isApiError(entry)) return [];
	const events: ChatEventBody[] = [];
	for (const event of mapper.map({
		type: entry.type,
		message: entry.message,
	} as SDKMessage)) {
		if (
			event.type === "tool.output" &&
			event.part.type === "image" &&
			(!keepImages || !fits(event, maxBytes))
		) {
			events.push({
				...event,
				part: { type: "imageOmitted", mediaType: event.part.mediaType },
			});
		} else if (fits(event, maxBytes)) {
			events.push(event);
		}
	}
	return events;
}

/**
 * The transcript replayed as ordinary events after the snapshot (SPEC.md
 * §10.8): per turn, `turn.started`, the typed message, Claude's messages
 * and tool events, then `turn.finished`, each turn event carrying the time
 * from the transcript. Only the last REPLAY_TURNS turns are replayed; tool
 * images older than REPLAY_IMAGE_TURNS turns, or too large for one frame,
 * become `imageOmitted`. A running turn is left open.
 */
export function replayHistory(
	entries: readonly SessionMessage[],
	turnRunning: boolean,
	maxBytes = MAX_CHAT_SERVER_FRAME_BYTES,
	maxTurns = REPLAY_TURNS,
): { events: ChatEventBody[]; truncated: boolean } {
	// A `!` command is a group of its own, outside any turn, as it ran.
	const turns: SessionMessage[][] = [];
	for (const entry of entries) {
		if (entry.parent_tool_use_id !== null) continue;
		const afterShell = isShellEntry(turns.at(-1)?.[0]);
		const text = userText(entry) ?? "";
		const opens = isShellEntry(entry)
			? parseBashInput(text) !== null || !afterShell
			: isTyped(entry) || turns.length === 0 || afterShell;
		if (opens) turns.push([]);
		turns.at(-1)?.push(entry);
	}
	const kept = turns.slice(-maxTurns);
	const mapper = new ClaudeMessageMapper();
	const events: ChatEventBody[] = [];
	let lastAt = 0;
	kept.forEach((turn, index) => {
		if (isShellEntry(turn[0])) {
			events.push(...shellEvents(turn));
			return;
		}
		const keepImages = index >= kept.length - REPLAY_IMAGE_TURNS;
		lastAt = timeOf(turn[0], lastAt);
		events.push({ type: "turn.started", at: lastAt });
		for (const entry of turn) {
			events.push(...entryEvents(entry, mapper, keepImages, maxBytes));
		}
		if (!(turnRunning && index === kept.length - 1)) {
			lastAt = timeOf(turn.at(-1), lastAt);
			events.push({ type: "turn.finished", status: statusOf(turn), at: lastAt });
		}
	});
	return { events, truncated: turns.length > kept.length };
}

/** Most entries of a subagent's transcript replayed when it is watched. */
export const REPLAY_SUBAGENT_ENTRIES = 500;
/** The newest entries whose images a subagent replay keeps; older ones say `imageOmitted`. */
export const REPLAY_SUBAGENT_IMAGE_ENTRIES = 20;

/**
 * A subagent's transcript replayed as one turn: the prompt it was given as a
 * user message, then its messages and tool events, then `turn.finished`
 * unless it is still running. Only the last REPLAY_SUBAGENT_ENTRIES entries
 * are replayed. An image older than the last REPLAY_SUBAGENT_IMAGE_ENTRIES
 * entries, or too large for one frame, becomes `imageOmitted`.
 */
export function replaySubagent(
	entries: readonly SessionMessage[],
	running: boolean,
	now: number,
	maxBytes = MAX_CHAT_SERVER_FRAME_BYTES,
): { events: ChatEventBody[]; truncated: boolean } {
	const kept = entries.slice(-REPLAY_SUBAGENT_ENTRIES);
	const truncated = kept.length < entries.length;
	const mapper = new ClaudeMessageMapper();
	const events: ChatEventBody[] = [{ type: "turn.started", at: timeOf(kept[0], now) }];
	kept.forEach((entry, index) => {
		// The first entry is the prompt the subagent was given.
		const prompt = index === 0 && !truncated ? plainText(entry) : null;
		if (prompt !== null) {
			events.push({ type: "message", id: entry.uuid, role: "user", markdown: prompt });
			return;
		}
		const keepImages = index >= kept.length - REPLAY_SUBAGENT_IMAGE_ENTRIES;
		events.push(...entryEvents(entry, mapper, keepImages, maxBytes));
	});
	if (!running) {
		events.push({
			type: "turn.finished",
			status: statusOf(kept),
			at: timeOf(kept.at(-1), now),
		});
	}
	return { events, truncated };
}

/**
 * The part of a Claude transcript since a swap handed it the conversation:
 * from the prompt that carried handoff `id`, or nothing while that prompt
 * is unsent. Without a handoff, the whole transcript.
 */
export function sinceHandoff(
	entries: readonly SessionMessage[],
	id: string | null,
): readonly SessionMessage[] {
	if (id === null) return entries;
	const at = entries.findIndex((entry) => carriesHandoff(entry, id));
	return at < 0 ? [] : entries.slice(at);
}

/** Whether this entry is the prompt that carried handoff `id`. */
export function carriesHandoff(entry: SessionMessage, id: string): boolean {
	return entry.type === "user" && splitHandoff(userText(entry) ?? "").id === id;
}
