import { describe, expect, test } from "vitest";
import { AgentCreateTerminalRequest } from "./agent.js";
import {
	CHAT_START_SETTINGS,
	ChatCardQuestion,
	ChatClientMessage,
	ChatEffort,
	ChatLastSettings,
	ChatModel,
	ChatPermissionMode,
	ChatQuestion,
	ChatServerEvent,
	ChatShellItem,
	chatStartMode,
	decodedBase64Bytes,
	MAX_CHAT_ATTACHMENTS,
	MAX_CHAT_EFFORTS,
	MAX_CHAT_IMAGE_BYTES,
	MAX_CHAT_MCP_SERVERS,
	MAX_CHAT_MODELS,
	MAX_CHAT_MODES,
	MAX_CHAT_PLAN_CHARS,
	MAX_CHAT_QUESTION_HEADER_CHARS,
	MAX_CHAT_RULE_CHARS,
	MAX_CHAT_SERVER_FRAME_BYTES,
	MAX_CHAT_TEXT_CHARS,
	StoredChatSettings,
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
		{ type: "card.resolved", ...env, id: "p1", decision: "allowedAlways" },
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

	test("a card.resolved decision must be one of the three fixed words", () => {
		const resolved = { type: "card.resolved", ...env, id: "p1" };
		for (const decision of ["allowed", "allowedAlways", "denied"]) {
			expect(ChatServerEvent.safeParse({ ...resolved, decision }).success).toBe(true);
		}
		expect(ChatServerEvent.safeParse(resolved).success).toBe(true);
		expect(ChatServerEvent.safeParse({ ...resolved, decision: "allow" }).success).toBe(
			false,
		);
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

	test("question counts: 1 to 4 questions of 0 to 4 options", () => {
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
		expect(ask([question(0)])).toBe(true);
		expect(ask([question(1)])).toBe(true);
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

	test("a malformed permission mode is refused", () => {
		expect(ChatClientMessage.safeParse({ type: "set", mode: "dont ask" }).success).toBe(
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

	test("a chat must name an agent, either one", () => {
		expect(
			CreateTerminalRequest.safeParse({ kind: "chat", agent: "claude" }).success,
		).toBe(true);
		expect(
			CreateTerminalRequest.safeParse({ kind: "chat", agent: "codex" }).success,
		).toBe(true);
		expect(
			CreateTerminalRequest.safeParse({ kind: "chat", agent: "gemini" }).success,
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

describe("session rules", () => {
	test("the host reports rules and the browser may revoke one", () => {
		const rules = [
			{ rule: "Bash(sed:*)", description: '"sed" commands in this session' },
		];
		expect(ChatServerEvent.safeParse({ type: "rules", ...env, rules }).success).toBe(
			true,
		);
		expect(
			ChatClientMessage.safeParse({ type: "rule.revoke", rule: "Bash(sed:*)" }).success,
		).toBe(true);
		expect(ChatClientMessage.safeParse({ type: "rule.revoke", rule: "" }).success).toBe(
			false,
		);
		expect(
			ChatClientMessage.safeParse({
				type: "rule.revoke",
				rule: "x".repeat(MAX_CHAT_RULE_CHARS + 1),
			}).success,
		).toBe(false);
	});
});

describe("permission answers with a message or a next mode", () => {
	const answer = (extra: object = {}) =>
		ChatClientMessage.safeParse({
			type: "permission.answer",
			id: "p1",
			optionId: "allow",
			...extra,
		}).success;

	test("an old answer without them still parses", () => {
		expect(answer()).toBe(true);
	});

	test("a message is 1 to 2,000 characters", () => {
		expect(answer({ message: "x" })).toBe(true);
		expect(answer({ message: "x".repeat(2000) })).toBe(true);
		expect(answer({ message: "" })).toBe(false);
		expect(answer({ message: "x".repeat(2001) })).toBe(false);
	});

	test("a plan approval may name acceptEdits or default and nothing else", () => {
		expect(answer({ mode: "acceptEdits" })).toBe(true);
		expect(answer({ mode: "default" })).toBe(true);
		expect(answer({ mode: "plan" })).toBe(false);
		expect(answer({ mode: "bypassPermissions" })).toBe(false);
		expect(answer({ other: 1 })).toBe(false);
	});
});

describe("the commands event", () => {
	const event = (commands: unknown) => ({ type: "commands", ...env, commands });
	const command = (change: object = {}) => ({
		name: "compact",
		description: "Shrink the conversation",
		terminalOnly: false,
		...change,
	});
	const ok = (commands: unknown) => ChatServerEvent.safeParse(event(commands)).success;

	test("lists commands, with an optional argument hint", () => {
		expect(ok([command(), command({ name: "model", argumentHint: "[name]" })])).toBe(
			true,
		);
		expect(ok([])).toBe(true);
	});

	test("keeps names, descriptions and hints within bounds", () => {
		expect(ok([command({ name: "" })])).toBe(false);
		expect(ok([command({ name: "a".repeat(64) })])).toBe(true);
		expect(ok([command({ name: "a".repeat(65) })])).toBe(false);
		expect(ok([command({ name: "/compact" })])).toBe(false);
		expect(ok([command({ description: "d".repeat(200) })])).toBe(true);
		expect(ok([command({ description: "d".repeat(201) })])).toBe(false);
		expect(ok([command({ argumentHint: "h".repeat(100) })])).toBe(true);
		expect(ok([command({ argumentHint: "h".repeat(101) })])).toBe(false);
		expect(ok([command({ terminalOnly: undefined })])).toBe(false);
	});

	test("lists at most 200 commands", () => {
		expect(ok(Array.from({ length: 200 }, () => command()))).toBe(true);
		expect(ok(Array.from({ length: 201 }, () => command()))).toBe(false);
	});
});

describe("the context event", () => {
	const ok = (change: object = {}) =>
		ChatServerEvent.safeParse({
			type: "context",
			...env,
			usedTokens: 1200,
			windowTokens: 200_000,
			cache: { at: 1_700_000_000_000, ttlSeconds: 300 },
			...change,
		}).success;

	test("takes a window and a cache, or nulls for either", () => {
		expect(ok()).toBe(true);
		expect(ok({ windowTokens: null })).toBe(true);
		expect(ok({ cache: null })).toBe(true);
		expect(ok({ cache: { at: 1, ttlSeconds: 3600 } })).toBe(true);
	});

	test("keeps the counts and the cache lifetime in range", () => {
		expect(ok({ usedTokens: 0 })).toBe(true);
		expect(ok({ usedTokens: -1 })).toBe(false);
		expect(ok({ usedTokens: 1.5 })).toBe(false);
		expect(ok({ windowTokens: 0 })).toBe(false);
		expect(ok({ windowTokens: -5 })).toBe(false);
		expect(ok({ cache: { at: 1, ttlSeconds: 60 } })).toBe(false);
		expect(ok({ cache: { at: 1.5, ttlSeconds: 300 } })).toBe(false);
		expect(ok({ cache: { at: -1, ttlSeconds: 300 } })).toBe(false);
	});
});

describe("a shell command item", () => {
	const item = (change: object = {}) => ({
		kind: "shell",
		id: "s1",
		command: "ls",
		output: "a\nb\n",
		exitCode: 0,
		truncated: false,
		state: "done",
		...change,
	});
	const ok = (change?: object) => ChatShellItem.safeParse(item(change)).success;

	test("takes a running command with no exit code yet", () => {
		expect(ok()).toBe(true);
		expect(ok({ state: "running", exitCode: null, output: "" })).toBe(true);
		expect(ok({ exitCode: 127 })).toBe(true);
	});

	test("keeps the command, output and state in bounds", () => {
		expect(ok({ command: "c".repeat(4000) })).toBe(true);
		expect(ok({ command: "c".repeat(4001) })).toBe(false);
		expect(ok({ output: "o".repeat(65_536) })).toBe(true);
		expect(ok({ output: "o".repeat(65_537) })).toBe(false);
		expect(ok({ exitCode: 1.5 })).toBe(false);
		expect(ok({ state: "failed" })).toBe(false);
		expect(ok({ id: "" })).toBe(false);
		expect(ok({ kind: "tool" })).toBe(false);
	});

	test("the host sends it as a shell event", () => {
		const { kind: _kind, ...fields } = item();
		expect(
			ChatServerEvent.safeParse({ type: "shell", ...env, ...fields }).success,
		).toBe(true);
		expect(
			ChatServerEvent.safeParse({ type: "shell", ...env, ...fields, state: "x" })
				.success,
		).toBe(false);
	});
});

describe("read aloud in the saved settings", () => {
	const base = { model: "sonnet", effort: "high", mode: "default" };

	test("an old saved value without it still parses, and reads as off", () => {
		expect(ChatLastSettings.safeParse(base).success).toBe(true);
		expect(StoredChatSettings.parse(base).readAloud).toBe(false);
	});

	test("takes a boolean and refuses anything else from the browser", () => {
		expect(ChatLastSettings.safeParse({ ...base, readAloud: true }).success).toBe(true);
		expect(ChatLastSettings.safeParse({ ...base, readAloud: "yes" }).success).toBe(
			false,
		);
		expect(StoredChatSettings.parse({ ...base, readAloud: true }).readAloud).toBe(true);
	});

	test("a bad stored value reads as off", () => {
		expect(StoredChatSettings.parse({ ...base, readAloud: "yes" }).readAloud).toBe(
			false,
		);
		expect(StoredChatSettings.parse({ ...base, readAloud: null }).readAloud).toBe(
			false,
		);
	});
});

describe("host clock and ignored plan mode", () => {
	const env = { sessionId: "00000000-0000-4000-8000-000000000001", seq: 1 };
	const context = {
		type: "context",
		...env,
		usedTokens: 1,
		windowTokens: null,
		cache: null,
	};

	test("a context event may carry the host's clock, and an older host's need not", () => {
		expect(ChatServerEvent.safeParse({ ...context, now: 5 }).success).toBe(true);
		expect(ChatServerEvent.safeParse(context).success).toBe(true);
		expect(ChatServerEvent.safeParse({ ...context, now: -1 }).success).toBe(false);
	});

	test("an older browser's permission answer with a mode still parses", () => {
		const answer = { type: "permission.answer", id: "p", optionId: "allow-ask-edits" };
		expect(ChatClientMessage.safeParse(answer).success).toBe(true);
		expect(
			ChatClientMessage.safeParse({ ...answer, mode: "acceptEdits" }).success,
		).toBe(true);
	});
});

describe("models", () => {
	const env = { sessionId: "00000000-0000-4000-8000-000000000001", seq: 1 };
	const row = (value: string, supportsAutoMode = true) => ({
		value,
		resolvedModel: "claude-opus-5-5",
		displayName: "Opus 5.5",
		description: "For complex work",
		supportsAutoMode,
	});

	test("a model is a short name or a full ID, with the brackets of a suffix", () => {
		for (const ok of ["default", "opus", "claude-opus-4-8", "claude-opus-5-5[1m]"]) {
			expect(ChatModel.safeParse(ok).success).toBe(true);
		}
		for (const bad of ["", "-opus", "Opus", "opus 5", "opus;rm", "x".repeat(101)]) {
			expect(ChatModel.safeParse(bad).success).toBe(false);
		}
	});

	test("the saved values from before still parse, and what cannot be read starts a new chat", () => {
		for (const model of ["default", "opus", "sonnet", "haiku"]) {
			expect(
				ChatLastSettings.safeParse({ model, effort: "high", mode: "default" }).success,
			).toBe(true);
		}
		const stored = StoredChatSettings.parse({
			model: "Not A Model",
			effort: "Huge!",
			mode: "low mode",
		});
		// What cannot be read is what a new chat starts with.
		expect(stored).toEqual({
			model: "opus",
			effort: "medium",
			mode: "auto",
			readAloud: false,
			agent: "claude",
		});
		expect(
			StoredChatSettings.parse({ model: "default", effort: "high", mode: "default" }),
		).toMatchObject({ model: "default", effort: "high", mode: "default" });
		expect(
			StoredChatSettings.parse({
				model: "claude-opus-4-8",
				effort: "low",
				mode: "plan",
			}).model,
		).toBe("claude-opus-4-8");
	});

	test("a models event lists at most 50 rows", () => {
		const event = (count: number) => ({
			type: "models",
			...env,
			models: Array.from({ length: count }, (_, index) => row(`m${index}`)),
		});
		expect(MAX_CHAT_MODELS).toBe(50);
		expect(ChatServerEvent.safeParse(event(50)).success).toBe(true);
		expect(ChatServerEvent.safeParse(event(51)).success).toBe(false);
		expect(
			ChatServerEvent.safeParse({ type: "models", ...env, models: [row("Bad Value")] })
				.success,
		).toBe(false);
	});

	test("a set may carry any valid model but not a malformed one", () => {
		expect(
			ChatClientMessage.safeParse({ type: "set", model: "claude-fable-5-1" }).success,
		).toBe(true);
		expect(ChatClientMessage.safeParse({ type: "set", model: "A B" }).success).toBe(
			false,
		);
	});

	test("a new chat starts at Opus, Medium and Auto, or Ask when the model has no Auto", () => {
		expect(CHAT_START_SETTINGS).toEqual({
			model: "opus",
			effort: "medium",
			mode: "auto",
		});
		expect(chatStartMode([row("opus")], "opus")).toBe("auto");
		expect(chatStartMode([row("opus", false)], "opus")).toBe("default");
		// An unknown model or an empty list does not block Auto.
		expect(chatStartMode([], "opus")).toBe("auto");
		expect(chatStartMode([row("sonnet", false)], "opus")).toBe("auto");
	});
});

describe("effort and permission mode are bounded strings", () => {
	test("accept the ids each agent uses, including ones added later", () => {
		for (const ok of ["low", "medium", "high", "xhigh", "max", "ultra", "x-high_2"]) {
			expect(ChatEffort.safeParse(ok).success).toBe(true);
		}
		for (const ok of ["default", "acceptEdits", "bypassPermissions", "fullAccess"]) {
			expect(ChatPermissionMode.safeParse(ok).success).toBe(true);
		}
	});

	test("refuse empty, over-long and unsafe values", () => {
		for (const bad of ["", "High", "1x", "a b", "a;b", "a/b", "x".repeat(33)]) {
			expect(ChatEffort.safeParse(bad).success).toBe(false);
		}
		for (const bad of ["", "1mode", "a b", "a.b", "a;b", "x".repeat(41)]) {
			expect(ChatPermissionMode.safeParse(bad).success).toBe(false);
		}
		expect(ChatEffort.safeParse("x".repeat(32)).success).toBe(true);
		expect(ChatPermissionMode.safeParse("x".repeat(40)).success).toBe(true);
	});

	test("a set and a settings event carry them", () => {
		expect(
			ChatClientMessage.safeParse({ type: "set", effort: "ultra", mode: "fullAccess" })
				.success,
		).toBe(true);
		expect(ChatClientMessage.safeParse({ type: "set", effort: "a b" }).success).toBe(
			false,
		);
		expect(
			ChatServerEvent.safeParse({
				type: "settings",
				...env,
				agent: "codex",
				model: "gpt-5.5",
				effort: "ultra",
				mode: "fullAccess",
			}).success,
		).toBe(true);
	});
});

describe("model efforts", () => {
	const base = {
		value: "gpt-5.5",
		displayName: "GPT-5.5",
		description: "d",
		supportsAutoMode: true,
	};
	const models = (row: object) =>
		ChatServerEvent.safeParse({ type: "models", ...env, models: [row] }).success;

	test("a model lists its efforts and a default, and an older host may leave them out", () => {
		expect(models(base)).toBe(true);
		expect(models({ ...base, efforts: ["low", "high"], defaultEffort: "low" })).toBe(
			true,
		);
		expect(models({ ...base, efforts: [] })).toBe(true);
	});

	test("refuses a malformed effort or too many", () => {
		expect(models({ ...base, efforts: ["Low"] })).toBe(false);
		expect(models({ ...base, defaultEffort: "a b" })).toBe(false);
		const many = (count: number) =>
			Array.from({ length: count }, (_, index) => `e${index}`);
		expect(models({ ...base, efforts: many(MAX_CHAT_EFFORTS) })).toBe(true);
		expect(models({ ...base, efforts: many(MAX_CHAT_EFFORTS + 1) })).toBe(false);
	});
});

describe("the modes event", () => {
	const mode = (change: object = {}) => ({
		id: "fullAccess",
		label: "Full access",
		description: "Runs anything without asking",
		warning: true,
		plan: false,
		...change,
	});
	const ok = (modes: unknown) =>
		ChatServerEvent.safeParse({ type: "modes", ...env, modes }).success;

	test("lists modes with a warning flag and a plan flag", () => {
		expect(
			ok([mode(), mode({ id: "plan", label: "Plan", warning: false, plan: true })]),
		).toBe(true);
		expect(ok([])).toBe(true);
	});

	test("keeps ids, labels and descriptions within bounds", () => {
		expect(ok([mode({ id: "a b" })])).toBe(false);
		expect(ok([mode({ label: "" })])).toBe(false);
		expect(ok([mode({ label: "l".repeat(41) })])).toBe(false);
		expect(ok([mode({ description: "d".repeat(300) })])).toBe(true);
		expect(ok([mode({ description: "d".repeat(301) })])).toBe(false);
		expect(ok([mode({ warning: undefined })])).toBe(false);
		expect(ok([mode({ plan: "yes" })])).toBe(false);
	});

	test("lists at most 10 modes", () => {
		expect(ok(Array.from({ length: MAX_CHAT_MODES }, () => mode()))).toBe(true);
		expect(ok(Array.from({ length: MAX_CHAT_MODES + 1 }, () => mode()))).toBe(false);
	});
});

describe("card buttons and plans", () => {
	const card = (change: object = {}) => ({
		type: "permission.requested",
		...env,
		id: "p1",
		toolName: "ExitPlanMode",
		title: "Approve the plan?",
		input: {},
		options: [
			{ id: "yes", label: "Yes", decision: "allowed" },
			{ id: "no", label: "No" },
		],
		...change,
	});

	test("a button may name its decision, and an older host's buttons parse", () => {
		expect(ChatServerEvent.safeParse(card()).success).toBe(true);
		for (const decision of ["allowed", "allowedAlways", "denied"]) {
			expect(
				ChatServerEvent.safeParse(
					card({ options: [{ id: "x", label: "X", decision }] }),
				).success,
			).toBe(true);
		}
		expect(
			ChatServerEvent.safeParse(
				card({ options: [{ id: "x", label: "X", decision: "maybe" }] }),
			).success,
		).toBe(false);
	});

	test("a card may carry its plan, within a cap", () => {
		expect(ChatServerEvent.safeParse(card({ plan: "1. Do it" })).success).toBe(true);
		expect(
			ChatServerEvent.safeParse(card({ plan: "p".repeat(MAX_CHAT_PLAN_CHARS) }))
				.success,
		).toBe(true);
		expect(
			ChatServerEvent.safeParse(card({ plan: "p".repeat(MAX_CHAT_PLAN_CHARS + 1) }))
				.success,
		).toBe(false);
		expect(ChatServerEvent.safeParse(card({ plan: 5 })).success).toBe(false);
	});

	test("a snapshot's open card carries both fields too", () => {
		const open = {
			type: "permission",
			id: "p1",
			toolName: "t",
			title: "t",
			input: {},
			options: [{ id: "y", label: "Y", decision: "allowed" }],
			plan: "steps",
		};
		expect(
			ChatServerEvent.safeParse({
				type: "snapshot",
				...env,
				cards: [open],
				turnRunning: false,
				truncated: false,
			}).success,
		).toBe(true);
	});
});

describe("card questions", () => {
	const option = { label: "A", description: "a" };
	const ask = (change: object = {}) => ({
		question: "Which?",
		header: "Pick",
		multiSelect: false,
		options: [option, { ...option, label: "B" }],
		...change,
	});
	const asked = (questions: unknown) =>
		ChatServerEvent.safeParse({
			type: "question.requested",
			...env,
			id: "q",
			questions,
		}).success;

	test("a card question may have no options, up to four, and may be secret", () => {
		expect(asked([ask({ options: [] })])).toBe(true);
		expect(asked([ask({ options: [option] })])).toBe(true);
		expect(asked([ask({ options: Array.from({ length: 4 }, () => option) })])).toBe(
			true,
		);
		expect(asked([ask({ options: Array.from({ length: 5 }, () => option) })])).toBe(
			false,
		);
		expect(asked([ask({ options: [], secret: true })])).toBe(true);
		expect(asked([ask({ secret: "yes" })])).toBe(false);
	});

	test("the terminal question's strict shape is unchanged", () => {
		expect(ChatQuestion.safeParse(ask()).success).toBe(true);
		expect(ChatQuestion.safeParse(ask({ options: [] })).success).toBe(false);
		expect(ChatQuestion.safeParse(ask({ options: [option] })).success).toBe(false);
		expect(ChatCardQuestion.safeParse(ask()).success).toBe(true);
	});
});

describe("command prefix", () => {
	const ok = (change: object) =>
		ChatServerEvent.safeParse({
			type: "commands",
			...env,
			commands: [{ name: "lint", description: "d", terminalOnly: false, ...change }],
		}).success;

	test("is a slash or a dollar sign, and may be left out", () => {
		expect(ok({})).toBe(true);
		expect(ok({ prefix: "/" })).toBe(true);
		expect(ok({ prefix: "$" })).toBe(true);
		expect(ok({ prefix: "!" })).toBe(false);
		expect(ok({ prefix: "" })).toBe(false);
	});
});

describe("the mcp event", () => {
	const ok = (servers: unknown) =>
		ChatServerEvent.safeParse({ type: "mcp", ...env, servers }).success;

	test("lists each server's name and one of five statuses", () => {
		for (const status of ["connected", "starting", "failed", "needsAuth", "disabled"]) {
			expect(ok([{ name: "docs", status }])).toBe(true);
		}
		expect(ok([])).toBe(true);
		expect(ok([{ name: "docs", status: "broken" }])).toBe(false);
	});

	test("bounds names and the list, and has no room for an address or error", () => {
		expect(ok([{ name: "", status: "failed" }])).toBe(false);
		expect(ok([{ name: "n".repeat(64), status: "failed" }])).toBe(true);
		expect(ok([{ name: "n".repeat(65), status: "failed" }])).toBe(false);
		const list = (count: number) =>
			Array.from({ length: count }, (_, index) => ({
				name: `s${index}`,
				status: "connected",
			}));
		expect(ok(list(MAX_CHAT_MCP_SERVERS))).toBe(true);
		expect(ok(list(MAX_CHAT_MCP_SERVERS + 1))).toBe(false);
		const parsed = ChatServerEvent.parse({
			type: "mcp",
			...env,
			servers: [{ name: "docs", status: "failed", url: "https://x", error: "boom" }],
		});
		expect(parsed).toMatchObject({ servers: [{ name: "docs", status: "failed" }] });
		expect(JSON.stringify(parsed)).not.toContain("https://x");
		expect(JSON.stringify(parsed)).not.toContain("boom");
	});
});

describe("switching agents", () => {
	test("the browser asks for the other agent, and only a known one", () => {
		expect(
			ChatClientMessage.safeParse({ type: "agent.switch", agent: "codex" }).success,
		).toBe(true);
		expect(
			ChatClientMessage.safeParse({ type: "agent.switch", agent: "claude" }).success,
		).toBe(true);
		expect(
			ChatClientMessage.safeParse({ type: "agent.switch", agent: "gemini" }).success,
		).toBe(false);
		expect(ChatClientMessage.safeParse({ type: "agent.switch" }).success).toBe(false);
		expect(
			ChatClientMessage.safeParse({ type: "agent.switch", agent: "codex", x: 1 })
				.success,
		).toBe(false);
	});

	test("the host marks the swap with a divider event", () => {
		const handoff = (change: object = {}) => ({
			type: "handoff",
			...env,
			from: "claude",
			to: "codex",
			droppedTurns: 0,
			...change,
		});
		expect(ChatServerEvent.safeParse(handoff()).success).toBe(true);
		expect(ChatServerEvent.safeParse(handoff({ droppedTurns: 7 })).success).toBe(true);
		expect(ChatServerEvent.safeParse(handoff({ droppedTurns: -1 })).success).toBe(
			false,
		);
		expect(ChatServerEvent.safeParse(handoff({ droppedTurns: 1.5 })).success).toBe(
			false,
		);
		expect(ChatServerEvent.safeParse(handoff({ to: "gemini" })).success).toBe(false);
		expect(ChatServerEvent.safeParse(handoff({ from: undefined })).success).toBe(false);
	});
});

describe("stored settings with an agent and Codex's own picks", () => {
	const claude = { model: "sonnet", effort: "high", mode: "default" };
	const codex = { model: "gpt-5.5", effort: "ultra", mode: "fullAccess" };

	test("a row from before them still parses, as Claude's and with no Codex object", () => {
		expect(ChatLastSettings.safeParse(claude).success).toBe(true);
		const stored = StoredChatSettings.parse(claude);
		expect(stored.agent).toBe("claude");
		expect(stored.codex).toBeUndefined();
	});

	test("the browser may save the last agent and Codex's picks, strictly", () => {
		expect(
			ChatLastSettings.safeParse({ ...claude, agent: "codex", codex }).success,
		).toBe(true);
		expect(ChatLastSettings.safeParse({ ...claude, agent: "gemini" }).success).toBe(
			false,
		);
		expect(
			ChatLastSettings.safeParse({ ...claude, codex: { ...codex, extra: 1 } }).success,
		).toBe(false);
		expect(
			ChatLastSettings.safeParse({ ...claude, codex: { model: "gpt-5.5" } }).success,
		).toBe(false);
	});

	test("a stored value is read back, and an unreadable one is dropped", () => {
		expect(
			StoredChatSettings.parse({ ...claude, agent: "codex", codex }),
		).toMatchObject({
			agent: "codex",
			codex,
		});
		const bad = StoredChatSettings.parse({
			...claude,
			agent: "gemini",
			codex: { ...codex, effort: "No Good" },
		});
		expect(bad.agent).toBe("claude");
		expect(bad.codex).toBeUndefined();
	});

	test("Claude's Bypass is still never carried into a new chat", () => {
		expect(
			StoredChatSettings.parse({ ...claude, mode: "bypassPermissions" }).mode,
		).toBe("auto");
	});
});
