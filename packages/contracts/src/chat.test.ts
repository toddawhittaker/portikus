import { describe, expect, test } from "vitest";
import { AgentCreateTerminalRequest } from "./agent.js";
import {
	ChatClientMessage,
	type ChatQuestion,
	ChatServerEvent,
	decodedBase64Bytes,
	MAX_CHAT_ATTACHMENTS,
	MAX_CHAT_IMAGE_BYTES,
	MAX_CHAT_QUESTION_HEADER_CHARS,
	MAX_CHAT_SERVER_FRAME_BYTES,
	MAX_CHAT_TEXT_CHARS,
} from "./chat.js";
import { CreateTerminalRequest, Terminal } from "./terminal.js";

const env = { sessionId: "11111111-1111-4111-8111-111111111111", seq: 0 };

function question(options = 2, header = "Library"): ChatQuestion {
	return {
		question: "Which library?",
		header,
		multiSelect: false,
		options: Array.from({ length: options }, (_, i) => ({
			label: `L${i}`,
			description: "d",
		})),
	};
}

/** Base64 of exactly `bytes` decoded bytes (a multiple of 3 needs no padding). */
function base64Of(bytes: number): string {
	return Buffer.alloc(bytes).toString("base64");
}

const image = (data: string, mediaType = "image/png") => ({
	type: "tool.output",
	...env,
	id: "t1",
	part: { type: "image", mediaType, data },
});

describe("chat server events (SPEC.md §10.8)", () => {
	const events: unknown[] = [
		{
			type: "snapshot",
			...env,
			cards: [
				{
					type: "permission",
					id: "p1",
					toolName: "Bash",
					title: "Run ls",
					input: { command: "ls" },
					options: [{ id: "allow", label: "Allow" }],
				},
				{ type: "question", id: "q1", questions: [question()] },
			],
			turnRunning: true,
			truncated: false,
		},
		{
			type: "snapshot",
			...env,
			cards: [],
			turnRunning: false,
			truncated: true,
		},
		{
			type: "tool.output",
			...env,
			id: "t1",
			part: { type: "imageOmitted", mediaType: "image/webp" },
		},
		{ type: "turn.started", ...env, at: 1_800_000_000_000 },
		{ type: "text.delta", ...env, messageId: "m2", text: "Hel" },
		{ type: "message", ...env, id: "m2", role: "assistant", markdown: "**Hello**" },
		{
			type: "message",
			...env,
			id: "m1",
			role: "user",
			markdown: "",
			attachments: [{ path: "a.png" }],
		},
		{
			type: "tool.started",
			...env,
			id: "t1",
			name: "Read",
			title: "Read a.ts",
			input: { file_path: "a.ts", n: [1, null] },
		},
		{ type: "tool.output", ...env, id: "t1", part: { type: "text", text: "ok" } },
		image(base64Of(3)),
		{ type: "tool.finished", ...env, id: "t1", isError: false },
		{
			type: "permission.requested",
			...env,
			id: "p1",
			toolName: "ExitPlanMode",
			title: "Plan",
			input: { plan: "x" },
			options: [{ id: "yes", label: "Yes" }],
		},
		{ type: "question.requested", ...env, id: "q1", questions: [question()] },
		{ type: "card.resolved", ...env, id: "q1" },
		{ type: "turn.finished", ...env, status: "interrupted", at: 1_800_000_001_000 },
		{ type: "error", ...env, message: "boom" },
		{
			type: "settings",
			...env,
			agent: "claude",
			model: "opus",
			effort: "xhigh",
			mode: "auto",
		},
	];

	test.each(events)("round trips %#", (event) => {
		const parsed = ChatServerEvent.parse(JSON.parse(JSON.stringify(event)));
		expect(parsed).toEqual(event);
	});

	test("seq must be a non-negative integer", () => {
		expect(
			ChatServerEvent.safeParse({ type: "turn.started", ...env, at: 0, seq: -1 })
				.success,
		).toBe(false);
		expect(
			ChatServerEvent.safeParse({ type: "turn.started", ...env, at: 0, seq: 1.5 })
				.success,
		).toBe(false);
	});

	test("turn events need the time they happened", () => {
		expect(ChatServerEvent.safeParse({ type: "turn.started", ...env }).success).toBe(
			false,
		);
		expect(
			ChatServerEvent.safeParse({ type: "turn.finished", ...env, status: "done" })
				.success,
		).toBe(false);
	});

	test("a snapshot carries no messages", () => {
		const snapshot = ChatServerEvent.parse({
			type: "snapshot",
			...env,
			messages: [{ id: "m", role: "user", markdown: "x" }],
			cards: [],
			turnRunning: false,
			truncated: false,
		});
		expect(snapshot).not.toHaveProperty("messages");
	});

	test("an image is accepted at 5 MiB and refused one byte over", () => {
		// 5 MiB is not a multiple of 3, so this also exercises padding.
		expect(
			ChatServerEvent.safeParse(image(base64Of(MAX_CHAT_IMAGE_BYTES))).success,
		).toBe(true);
		expect(
			ChatServerEvent.safeParse(image(base64Of(MAX_CHAT_IMAGE_BYTES + 1))).success,
		).toBe(false);
	});

	test("SVG and other media types are refused", () => {
		expect(ChatServerEvent.safeParse(image(base64Of(3), "image/svg+xml")).success).toBe(
			false,
		);
		expect(ChatServerEvent.safeParse(image(base64Of(3), "text/html")).success).toBe(
			false,
		);
	});

	test("non-base64 image data is refused", () => {
		expect(ChatServerEvent.safeParse(image("<svg>")).success).toBe(false);
	});

	test("question counts: 1 to 4 questions of 2 to 4 options", () => {
		const ask = (questions: ChatQuestion[]) =>
			ChatServerEvent.safeParse({
				type: "question.requested",
				...env,
				id: "q",
				questions,
			}).success;
		expect(ask([])).toBe(false);
		expect(ask(Array(4).fill(question()))).toBe(true);
		expect(ask(Array(5).fill(question()))).toBe(false);
		expect(ask([question(1)])).toBe(false);
		expect(ask([question(4)])).toBe(true);
		expect(ask([question(5)])).toBe(false);
		expect(ask([question(2, "h".repeat(MAX_CHAT_QUESTION_HEADER_CHARS))])).toBe(true);
		expect(ask([question(2, "h".repeat(MAX_CHAT_QUESTION_HEADER_CHARS + 1))])).toBe(
			false,
		);
	});
});

describe("chat client messages (SPEC.md §10.8)", () => {
	const messages: unknown[] = [
		{ type: "send", text: "look", attachments: [{ path: ".portikus/pastes/1/a.png" }] },
		{ type: "permission.answer", id: "p1", optionId: "allow" },
		{
			type: "question.answer",
			id: "q1",
			answers: { "Which?": "A, B" },
			notes: { "Which?": "also C" },
		},
		{ type: "question.answer", id: "q1", answers: { "Which?": "A" } },
		{ type: "interrupt" },
		{ type: "set", model: "sonnet", effort: "low", mode: "plan" },
		{ type: "set" },
	];

	test.each(messages)("round trips %#", (message) => {
		expect(ChatClientMessage.parse(JSON.parse(JSON.stringify(message)))).toEqual(
			message,
		);
	});

	const send = (text: string, count: number) =>
		ChatClientMessage.safeParse({
			type: "send",
			text,
			attachments: Array.from({ length: count }, (_, i) => ({ path: `f${i}` })),
		}).success;

	test("text is accepted at 100,000 characters and refused over", () => {
		expect(send("x".repeat(MAX_CHAT_TEXT_CHARS), 0)).toBe(true);
		expect(send("x".repeat(MAX_CHAT_TEXT_CHARS + 1), 0)).toBe(false);
	});

	test("attachments are accepted at 10 and refused at 11", () => {
		expect(send("", MAX_CHAT_ATTACHMENTS)).toBe(true);
		expect(send("", MAX_CHAT_ATTACHMENTS + 1)).toBe(false);
	});

	test("attachment paths must be project-relative", () => {
		for (const path of ["/etc/passwd", "../x", "a/../../x", ""]) {
			expect(
				ChatClientMessage.safeParse({ type: "send", text: "", attachments: [{ path }] })
					.success,
			).toBe(false);
		}
	});

	test("an unknown permission mode is refused", () => {
		expect(ChatClientMessage.safeParse({ type: "set", mode: "dontAsk" }).success).toBe(
			false,
		);
	});
});

describe("chat frame caps", () => {
	test("decodedBase64Bytes counts padding", () => {
		for (const n of [0, 1, 2, 3, 4, 5, MAX_CHAT_IMAGE_BYTES]) {
			expect(decodedBase64Bytes(base64Of(n))).toBe(n);
		}
	});

	test("a 5 MiB image in tool.output fits one server frame", () => {
		const frame = JSON.stringify(image(base64Of(MAX_CHAT_IMAGE_BYTES)));
		expect(Buffer.byteLength(frame)).toBeLessThanOrEqual(MAX_CHAT_SERVER_FRAME_BYTES);
		expect(ChatServerEvent.safeParse(JSON.parse(frame)).success).toBe(true);
	});
});

describe("terminal kind", () => {
	const row = {
		id: env.sessionId,
		workspaceId: env.sessionId,
		name: "shell",
		cwd: "/home/student",
		position: 0,
		projectId: null,
		createdAt: "2026-11-07T00:00:00.000Z",
		endedAt: null,
		theme: "dark",
	};

	test("a terminal without kind parses as a terminal", () => {
		expect(Terminal.parse(row).kind).toBe("terminal");
		expect(Terminal.parse({ ...row, kind: "chat" }).kind).toBe("chat");
	});

	test("a chat must use claude", () => {
		expect(
			CreateTerminalRequest.safeParse({ kind: "chat", agent: "claude" }).success,
		).toBe(true);
		expect(
			CreateTerminalRequest.safeParse({ kind: "chat", agent: "codex" }).success,
		).toBe(false);
		expect(CreateTerminalRequest.safeParse({ kind: "chat" }).success).toBe(false);
		expect(
			CreateTerminalRequest.safeParse({ kind: "terminal", agent: "codex" }).success,
		).toBe(true);
		expect(CreateTerminalRequest.safeParse({}).success).toBe(true);
	});

	test("resumeChatOf is allowed only on a chat", () => {
		const resumeChatOf = env.sessionId;
		expect(
			CreateTerminalRequest.safeParse({ kind: "chat", agent: "claude", resumeChatOf })
				.success,
		).toBe(true);
		expect(
			CreateTerminalRequest.safeParse({ agent: "claude", resumeChatOf }).success,
		).toBe(false);
		expect(
			CreateTerminalRequest.safeParse({
				kind: "chat",
				agent: "claude",
				resumeChatOf: "../x",
			}).success,
		).toBe(false);
		const agentBody = {
			id: env.sessionId,
			cwd: "/home/student/projects/a",
			theme: "dark",
			timezone: "America/New_York",
			agent: "claude",
		};
		expect(
			AgentCreateTerminalRequest.safeParse({ ...agentBody, kind: "chat", resumeChatOf })
				.success,
		).toBe(true);
		expect(
			AgentCreateTerminalRequest.safeParse({ ...agentBody, resumeChatOf }).success,
		).toBe(false);
	});
});
