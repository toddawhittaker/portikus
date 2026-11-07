import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { type ChatMessage, ChatServerEvent } from "@portikus/contracts";
import { describe, expect, test } from "vitest";
import { buildSnapshot, historyMessages } from "./snapshot.js";

const SESSION = "0b7e0a8e-3c1e-4c38-9a4e-2f0f6f7d1a11";

function entry(
	type: "user" | "assistant",
	message: unknown,
	parent: string | null = null,
): SessionMessage {
	return {
		type,
		uuid: crypto.randomUUID(),
		session_id: SESSION,
		message,
		parent_tool_use_id: parent,
		parent_agent_id: null,
	};
}

describe("history from the transcript", () => {
	test("keeps typed text and replies, joins one reply's blocks, drops tool results and subagents", () => {
		const history = historyMessages([
			entry("user", { role: "user", content: "hello" }),
			entry("assistant", { id: "m1", content: [{ type: "text", text: "Hi " }] }),
			entry("assistant", {
				id: "m1",
				content: [{ type: "tool_use", id: "t", name: "Bash", input: {} }],
			}),
			entry("assistant", { id: "m1", content: [{ type: "text", text: "there" }] }),
			entry("user", {
				role: "user",
				content: [{ type: "tool_result", tool_use_id: "t", content: "x" }],
			}),
			entry(
				"assistant",
				{ id: "sub", content: [{ type: "text", text: "subagent" }] },
				"t",
			),
		]);
		expect(history.map(({ role, markdown }) => ({ role, markdown }))).toEqual([
			{ role: "user", markdown: "hello" },
			{ role: "assistant", markdown: "Hi there" },
		]);
		expect(history[1]?.id).toBe("m1");
	});
});

function messages(count: number, size: number): ChatMessage[] {
	return Array.from({ length: count }, (_, i) => ({
		id: `m${i}`,
		role: i % 2 === 0 ? "user" : "assistant",
		markdown: "x".repeat(size),
	}));
}

describe("snapshot fill", () => {
	test("everything fits: nothing truncated", () => {
		const snapshot = buildSnapshot({
			sessionId: SESSION,
			seq: 3,
			history: messages(3, 10),
			cards: [],
			turnRunning: false,
		});
		expect(snapshot.messages).toHaveLength(3);
		expect(snapshot.truncated).toBe(false);
		expect(ChatServerEvent.safeParse(snapshot).success).toBe(true);
	});

	test("fills newest first and stops, truncated, at the frame limit", () => {
		const history = messages(50, 1000);
		const maxBytes = 10_500;
		const snapshot = buildSnapshot({
			sessionId: SESSION,
			seq: 0,
			history,
			cards: [],
			turnRunning: true,
			maxBytes,
		});
		expect(snapshot.truncated).toBe(true);
		expect(snapshot.messages.length).toBeGreaterThan(0);
		expect(snapshot.messages.length).toBeLessThan(50);
		// The kept messages are the newest ones, still oldest first.
		expect(snapshot.messages.at(-1)?.id).toBe("m49");
		expect(snapshot.messages.map((m) => m.id)).toEqual(
			history.slice(50 - snapshot.messages.length).map((m) => m.id),
		);
		expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeLessThanOrEqual(maxBytes);
	});

	test("open cards always ride along", () => {
		const card = {
			type: "permission" as const,
			id: "t1",
			toolName: "Bash",
			title: "Allow Bash?",
			input: { command: "ls" },
			options: [{ id: "allow", label: "Allow once" }],
		};
		const snapshot = buildSnapshot({
			sessionId: SESSION,
			seq: 0,
			history: messages(5, 1000),
			cards: [card],
			turnRunning: false,
			maxBytes: 1500,
		});
		expect(snapshot.cards).toEqual([card]);
		expect(snapshot.truncated).toBe(true);
	});
});
