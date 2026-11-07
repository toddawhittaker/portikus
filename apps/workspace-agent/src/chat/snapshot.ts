import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import {
	type ChatMessage,
	type ChatOpenCard,
	type ChatServerEvent,
	MAX_CHAT_SERVER_FRAME_BYTES,
} from "@portikus/contracts";

type Block = Record<string, unknown>;

function blocksOf(content: unknown): Block[] {
	if (typeof content === "string") return [{ type: "text", text: content }];
	if (!Array.isArray(content)) return [];
	return content.filter(
		(block): block is Block => typeof block === "object" && block !== null,
	);
}

function textOf(content: unknown): string {
	return blocksOf(content)
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text as string)
		.join("");
}

/**
 * The conversation as chat messages, oldest first: what the student typed
 * and what Claude answered in the main thread. Tool results and subagent
 * turns are left out; the transcript stores one entry per content block,
 * so entries of one assistant message are joined.
 */
export function historyMessages(entries: readonly SessionMessage[]): ChatMessage[] {
	const messages: ChatMessage[] = [];
	for (const entry of entries) {
		if (entry.parent_tool_use_id !== null) continue;
		if (entry.type !== "user" && entry.type !== "assistant") continue;
		const message = (entry.message ?? {}) as Block;
		const text = textOf(message.content);
		if (text === "") continue;
		if (entry.type === "user") {
			messages.push({ id: entry.uuid, role: "user", markdown: text });
			continue;
		}
		const id = typeof message.id === "string" ? message.id : entry.uuid;
		const last = messages.at(-1);
		if (last?.role === "assistant" && last.id === id) last.markdown += text;
		else messages.push({ id, role: "assistant", markdown: text });
	}
	return messages;
}

function bytes(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value), "utf8");
}

/**
 * The snapshot sent first on every attach (SPEC.md §10.8). It is filled
 * newest first, as chat.ts's `snapshot` doc requires, and stops adding
 * older messages, with `truncated` set, once the next one would not fit
 * in one server frame.
 */
export function buildSnapshot(input: {
	sessionId: string;
	seq: number;
	history: readonly ChatMessage[];
	cards: readonly ChatOpenCard[];
	turnRunning: boolean;
	maxBytes?: number;
}): Extract<ChatServerEvent, { type: "snapshot" }> {
	const maxBytes = input.maxBytes ?? MAX_CHAT_SERVER_FRAME_BYTES;
	const snapshot: Extract<ChatServerEvent, { type: "snapshot" }> = {
		type: "snapshot",
		sessionId: input.sessionId,
		seq: input.seq,
		messages: [],
		cards: [...input.cards],
		turnRunning: input.turnRunning,
		truncated: true,
	};
	// Measured with truncated true, the longer of the two spellings.
	let used = bytes(snapshot);
	const kept: ChatMessage[] = [];
	let truncated = false;
	for (let i = input.history.length - 1; i >= 0; i--) {
		const message = input.history[i] as ChatMessage;
		// One comma between array entries.
		const size = bytes(message) + (kept.length > 0 ? 1 : 0);
		if (used + size > maxBytes) {
			truncated = true;
			break;
		}
		used += size;
		kept.push(message);
	}
	snapshot.messages = kept.reverse();
	snapshot.truncated = truncated;
	return snapshot;
}
