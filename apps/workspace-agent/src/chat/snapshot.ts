import type { SDKMessage, SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import {
	type ChatMessage,
	type ChatOpenCard,
	type ChatServerEvent,
	MAX_CHAT_SERVER_FRAME_BYTES,
} from "@portikus/contracts";
import { type ChatEventBody, ClaudeMessageMapper } from "./claude-adapter.js";

/** Most turns replayed on attach (SPEC.md §10.8). */
export const REPLAY_TURNS = 20;
/** Only the newest turns keep their tool images on replay. */
export const REPLAY_IMAGE_TURNS = 5;
/** Room for the session id and sequence number the host stamps on. */
const ENVELOPE_BYTES = 128;

type Block = Record<string, unknown>;

function typedText(entry: SessionMessage): string | null {
	if (entry.type !== "user" || entry.parent_tool_use_id !== null) return null;
	const content = ((entry.message ?? {}) as Block).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return null;
	const blocks = content as Block[];
	if (blocks.some((block) => block?.type === "tool_result")) return null;
	const text = blocks
		.filter((block) => block?.type === "text" && typeof block.text === "string")
		.map((block) => block.text as string)
		.join("");
	return text === "" ? null : text;
}

function fits(event: ChatEventBody, maxBytes: number): boolean {
	return Buffer.byteLength(JSON.stringify(event), "utf8") + ENVELOPE_BYTES <= maxBytes;
}

/**
 * The transcript replayed as ordinary events after the snapshot (SPEC.md
 * §10.8): per turn, `turn.started`, the typed message, Claude's messages
 * and tool events, then `turn.finished`. Only the last REPLAY_TURNS turns
 * are replayed; tool images older than REPLAY_IMAGE_TURNS turns, or too
 * large for one frame, become `imageOmitted`. A running turn is left open.
 */
export function replayHistory(
	entries: readonly SessionMessage[],
	turnRunning: boolean,
	maxBytes = MAX_CHAT_SERVER_FRAME_BYTES,
): { events: ChatEventBody[]; truncated: boolean } {
	const turns: SessionMessage[][] = [];
	for (const entry of entries) {
		if (entry.parent_tool_use_id !== null) continue;
		if (typedText(entry) !== null || turns.length === 0) turns.push([]);
		turns.at(-1)?.push(entry);
	}
	const kept = turns.slice(-REPLAY_TURNS);
	const mapper = new ClaudeMessageMapper();
	const events: ChatEventBody[] = [];
	kept.forEach((turn, index) => {
		const keepImages = index >= kept.length - REPLAY_IMAGE_TURNS;
		events.push({ type: "turn.started" });
		for (const entry of turn) {
			const text = typedText(entry);
			if (text !== null) {
				events.push({ type: "message", id: entry.uuid, role: "user", markdown: text });
				continue;
			}
			if (entry.type !== "user" && entry.type !== "assistant") continue;
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
		}
		if (!(turnRunning && index === kept.length - 1)) {
			events.push({ type: "turn.finished", status: "done" });
		}
	});
	return { events, truncated: turns.length > kept.length };
}

/**
 * The snapshot sent first on every attach (SPEC.md §10.8). History follows
 * it as replayed events, so its messages hold only the reply streaming now.
 */
export function buildSnapshot(input: {
	sessionId: string;
	seq: number;
	cards: readonly ChatOpenCard[];
	turnRunning: boolean;
	truncated: boolean;
	streaming: ChatMessage | null;
}): Extract<ChatServerEvent, { type: "snapshot" }> {
	return {
		type: "snapshot",
		sessionId: input.sessionId,
		seq: input.seq,
		messages: input.streaming ? [input.streaming] : [],
		cards: [...input.cards],
		turnRunning: input.turnRunning,
		truncated: input.truncated,
	};
}
