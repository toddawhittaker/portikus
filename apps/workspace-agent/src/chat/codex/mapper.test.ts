import { ChatServerEvent } from "@portikus/contracts";
import { describe, expect, test } from "vitest";
import type { ChatEventBody } from "../agent.js";
import {
	approvalOptions,
	mcpAnswer,
	planCard,
	questionAnswer,
	questionCard,
} from "./cards.js";
import { codexCommands, slashCommand } from "./commands.js";
import { fixture, recordedResult } from "./fake-app-server.js";
import { replayTurns, shellItem } from "./history.js";
import { CodexItemMapper, shownCommand, toolRow } from "./mapper.js";
import { CODEX_MODES, DEFAULT_WORKSPACE_SANDBOX, modePolicy } from "./modes.js";
import {
	CommandItem,
	parsed,
	SkillsList,
	TurnsList,
	UserInputRequest,
} from "./protocol.js";

/** Every item the server finished in a fixture, in order. */
function completedItems(name: string): unknown[] {
	return fixture(name)
		.filter((line) => line.msg.method === "item/completed")
		.map((line) => (line.msg.params as { item: unknown }).item);
}

/** Each event must be a valid contract frame once the core stamps it. */
function valid(events: ChatEventBody[]): ChatEventBody[] {
	for (const event of events) {
		const framed = {
			...event,
			sessionId: "00000000-0000-4000-8000-000000000001",
			seq: 1,
		};
		expect(ChatServerEvent.safeParse(framed).success, JSON.stringify(event)).toBe(true);
	}
	return events;
}

describe("Codex items as chat rows", () => {
	test("each command kind keeps Codex's command action, with the inner command shown", () => {
		const rows = completedItems("command-kinds")
			.map(toolRow)
			.filter((row) => row !== null);
		expect(rows.map((row) => row.input)).toEqual([
			{
				command: "cat a.txt",
				actions: [{ type: "read", path: "/workspace/project/a.txt" }],
			},
			{ command: "ls", actions: [{ type: "listFiles", path: null }] },
			{
				command: "rg hello",
				actions: [{ type: "search", query: "hello", path: null }],
			},
			{ command: "echo done", actions: [{ type: "unknown" }] },
		]);
		expect(rows.every((row) => row.name === "commandExecution")).toBe(true);
		expect(rows[0]?.title).toBe("cat a.txt");
	});

	test("a finished command row carries its output and finishes without error", () => {
		const mapper = new CodexItemMapper();
		const [item] = completedItems("command-kinds").filter(
			(each) => toolRow(each) !== null,
		);
		const events = valid(mapper.completed(item));
		expect(events.map((event) => event.type)).toEqual([
			"tool.started",
			"tool.output",
			"tool.finished",
		]);
		expect(events[2]).toMatchObject({ isError: false });
		// Already started: finishing does not draw the row twice.
		const again = new CodexItemMapper();
		again.started(item);
		expect(again.completed(item).map((event) => event.type)).toEqual([
			"tool.output",
			"tool.finished",
		]);
	});

	test("a declined command finishes as an error", () => {
		const declined = completedItems("command-approval").find(
			(item) => (item as { status?: string }).status === "declined",
		);
		const events = new CodexItemMapper().completed(declined);
		expect(events.at(-1)).toMatchObject({ type: "tool.finished", isError: true });
	});

	test("a file change carries a unified diff for an update and for a new file", () => {
		const [update] = completedItems("file-change-diff")
			.map(toolRow)
			.filter((row) => row?.name === "fileChange");
		expect(update?.input).toEqual({
			changes: [
				{
					path: "/workspace/project/a.txt",
					kind: "update",
					diff: "@@ -1 +1 @@\n-<line>\n+<line>\n",
				},
			],
		});
		const [added] = completedItems("file-change-approval")
			.map(toolRow)
			.filter((row) => row?.name === "fileChange");
		expect(added?.input).toEqual({
			changes: [
				{
					path: "/workspace/project/note.txt",
					kind: "add",
					diff: "@@ -0,0 +1,1 @@\n+<line>\n",
				},
			],
		});
		expect(added?.title).toBe("/workspace/project/note.txt");
	});

	test("a deleted or moved file shows every line removed, and its new path", () => {
		const row = toolRow({
			type: "fileChange",
			id: "f1",
			status: "completed",
			changes: [
				{ path: "/p/old.txt", kind: { type: "delete" }, diff: "one\ntwo\n" },
				{
					path: "/p/b.txt",
					kind: { type: "update", move_path: "/p/c.txt" },
					diff: "@@ x @@\n",
				},
			],
		});
		expect(row?.title).toBe("2 files");
		expect(row?.input).toEqual({
			changes: [
				{ path: "/p/old.txt", kind: "delete", diff: "@@ -1,2 +0,0 @@\n-one\n-two\n" },
				{ path: "/p/b.txt", kind: "update", movePath: "/p/c.txt", diff: "@@ x @@\n" },
			],
		});
	});

	test("an MCP tool call shows its server, tool and arguments, and its text output", () => {
		const [call] = completedItems("mcp-approval").filter(
			(item) => (item as { type: string }).type === "mcpToolCall",
		);
		const events = valid(new CodexItemMapper().completed(call));
		expect(events[0]).toMatchObject({
			type: "tool.started",
			name: "mcpToolCall",
			title: "echo_word",
			input: { server: "echo", tool: "echo_word", arguments: { word: "hi" } },
		});
		expect(events[1]).toMatchObject({
			type: "tool.output",
			part: { type: "text", text: "<text>" },
		});
	});

	test("a failed MCP call shows its error; an image result is an image part", () => {
		const failed = new CodexItemMapper().completed({
			type: "mcpToolCall",
			id: "m1",
			server: "s",
			tool: "t",
			status: "failed",
			arguments: {},
			result: {
				content: [
					{ type: "image", mimeType: "image/png", data: "AAAA" },
					{ type: "other" },
				],
			},
			error: { message: "boom" },
		});
		expect(valid(failed).slice(1)).toEqual([
			{
				type: "tool.output",
				id: "m1",
				part: { type: "image", mediaType: "image/png", data: "AAAA" },
			},
			{ type: "tool.output", id: "m1", part: { type: "text", text: "boom" } },
			{ type: "tool.finished", id: "m1", isError: true },
		]);
	});

	test("subagent activity reads as a collaboration call naming the child thread", () => {
		const items = completedItems("subagent");
		const rows = items.map(toolRow).filter((row) => row !== null);
		expect(rows.map((row) => row.input)).toEqual([
			{ tool: "spawnAgent", receivers: ["00000000-0000-7000-8000-000000000005"] },
			{ tool: "wait", receivers: [] },
			{ tool: "sendInput", receivers: ["00000000-0000-7000-8000-000000000005"] },
			{ tool: "wait", receivers: [] },
		]);
		expect(rows.every((row) => row.name === "collabAgentToolCall")).toBe(true);
	});

	test("a collaboration call keeps its prompt; other tools keep their own input", () => {
		expect(
			toolRow({
				type: "collabAgentToolCall",
				id: "c",
				tool: "spawnAgent",
				status: "completed",
				receiverThreadIds: ["t1"],
				prompt: "Count",
			})?.input,
		).toEqual({ tool: "spawnAgent", receivers: ["t1"], prompt: "Count" });
		expect(toolRow({ type: "webSearch", id: "w", query: "zod" })).toMatchObject({
			name: "webSearch",
			input: { query: "zod" },
		});
		expect(toolRow({ type: "imageView", id: "i", path: "/p/a.png" })?.input).toEqual({
			path: "/p/a.png",
		});
		expect(
			toolRow({
				type: "dynamicToolCall",
				id: "d",
				tool: "x",
				arguments: { a: 1 },
				status: "completed",
			})?.input,
		).toEqual({ tool: "x", arguments: { a: 1 } });
	});

	test("an item the chat does not know becomes a plain row named by its type", () => {
		expect(toolRow({ type: "contextCompaction", id: "k" })).toEqual({
			id: "k",
			name: "contextCompaction",
			title: "contextCompaction",
			input: {},
		});
		// A known type with a changed shape falls back the same way.
		expect(toolRow({ type: "commandExecution", id: "x" })?.input).toEqual({});
		expect(toolRow({ nonsense: true })).toBeNull();
		expect(toolRow({ type: "reasoning", id: "r" })).toBeNull();
	});

	test("messages, a plan and a review are Codex's words, not rows", () => {
		const mapper = new CodexItemMapper();
		expect(mapper.completed({ type: "agentMessage", id: "a", text: "Hi" })).toEqual([
			{ type: "message", id: "a", role: "assistant", markdown: "Hi" },
		]);
		expect(mapper.completed({ type: "plan", id: "p", text: "1. Do" })).toMatchObject([
			{ type: "message", markdown: "1. Do" },
		]);
		expect(
			mapper.completed({ type: "exitedReviewMode", id: "r", review: "LGTM" }),
		).toMatchObject([{ markdown: "LGTM" }]);
		expect(mapper.completed({ type: "agentMessage", id: "e", text: "" })).toEqual([]);
		expect(mapper.delta("a", "x")).toEqual([
			{ type: "text.delta", messageId: "a", text: "x" },
		]);
		expect(mapper.delta("a", "")).toEqual([]);
	});

	test("each plan-steps update is its own finished row", () => {
		const mapper = new CodexItemMapper();
		const steps = [{ step: "Read", status: "completed" }];
		const first = valid(mapper.planSteps("t", steps));
		const second = mapper.planSteps("t", steps);
		expect(first[0]).toMatchObject({ name: "planSteps", input: { steps } });
		expect(first[0]).not.toEqual(second[0]);
	});

	test("a replayed plan is Codex's words and a finished plan row with the same id", () => {
		const events = replayTurns([
			{
				id: "t",
				status: "completed",
				items: [{ type: "plan", id: "p", text: "1. Do" }],
			},
		] as never);
		expect(valid(events.slice(1, -1))).toEqual([
			{ type: "message", id: "p", role: "assistant", markdown: "1. Do" },
			{
				type: "tool.started",
				id: "p",
				name: "plan",
				title: "Plan",
				input: { plan: "1. Do" },
			},
			{ type: "tool.finished", id: "p", isError: false },
		]);
	});

	test("an MCP approval finds the running call with its arguments, skipping rows that hold a card", () => {
		const mapper = new CodexItemMapper();
		const call = (id: string, word: string, status = "inProgress") => ({
			type: "mcpToolCall",
			id,
			server: "echo",
			tool: "echo_word",
			status,
			arguments: { word },
		});
		mapper.started(call("done", "a"));
		mapper.completed(call("done", "a", "completed"));
		mapper.started(call("one", "a"));
		mapper.started(call("two", "b"));
		mapper.started(call("three", "a"));
		const none = new Set<string>();
		expect(mapper.mcpRow("echo", "echo_word", { word: "b" }, none)?.id).toBe("two");
		expect(mapper.mcpRow("echo", "echo_word", { word: "a" }, none)?.id).toBe("one");
		expect(
			mapper.mcpRow("echo", "echo_word", { word: "a" }, new Set(["one"]))?.id,
		).toBe("three");
		expect(mapper.mcpRow("echo", "echo_word", undefined, none)?.id).toBe("one");
		expect(mapper.mcpRow("echo", "other", undefined, none)).toBeUndefined();
	});

	test("the shell wrapper Codex adds is taken off", () => {
		expect(shownCommand("/bin/bash -lc 'echo it'\\''s'")).toBe("echo it's");
		expect(shownCommand("/bin/bash -lc ls")).toBe("ls");
		expect(shownCommand("bash -c 'a' extra")).toBe("'a' extra");
		expect(shownCommand("python x.py")).toBe("python x.py");
	});
});

describe("history replay", () => {
	test("a resumed thread replays its turns as the live chat drew them", () => {
		const page = parsed(
			TurnsList,
			recordedResult("resume-turns-list", "thread/turns/list"),
		);
		const events = valid(replayTurns(page?.data ?? []));
		expect(events).toEqual([
			{ type: "turn.started", at: 1794605996000 },
			{
				type: "message",
				id: "00000000-0000-7000-8000-000000000004",
				role: "user",
				markdown: "<text>",
			},
			{ type: "message", id: "msg_0001", role: "assistant", markdown: "<text>" },
			{ type: "turn.finished", status: "done", at: 1794605999000 },
		]);
	});

	test("attachments come back from their lines; a running turn has no end", () => {
		const events = replayTurns([
			{
				id: "t",
				status: "inProgress",
				startedAt: 1,
				items: [
					{
						type: "userMessage",
						id: "u",
						content: [
							{ type: "text", text: "Look\n\nAttached file: a.png" },
							{ type: "localImage", path: "/p/a.png" },
						],
					},
					{
						type: "commandExecution",
						id: "c",
						command: "ls",
						status: "inProgress",
						commandActions: [],
					},
					{ type: "agentMessage", id: "m", text: "partial", completedAtMs: null },
				],
			},
		]);
		expect(events).toEqual([
			{ type: "turn.started", at: 1000 },
			{
				type: "message",
				id: "u",
				role: "user",
				markdown: "Look",
				attachments: [{ path: "a.png" }],
			},
			expect.objectContaining({ type: "tool.started", id: "c" }),
		]);
	});

	test("a turn that only ran a `!` command replays as that command", () => {
		const shellTurn = fixture("shell-command").find(
			(line) =>
				line.msg.method === "item/completed" &&
				(line.msg.params as { item: { source?: string } }).item.source === "userShell",
		);
		const item = (shellTurn?.msg.params as { item: unknown } | undefined)?.item;
		const events = valid(
			replayTurns([
				{ id: "t", status: "completed", items: [item] },
				{ id: "u", status: "failed", items: [] },
			]),
		);
		expect(events[0]).toEqual({
			type: "shell",
			id: "00000000-0000-7000-8000-000000000004",
			command: "echo hi",
			output: "<output>\n",
			exitCode: 0,
			truncated: false,
			state: "done",
		});
		expect(events.at(-1)).toMatchObject({ type: "turn.finished", status: "error" });
	});

	test("a stopped `!` command has no exit code, and long output is cut", () => {
		const command = parsed(CommandItem, {
			command: "sleep 30",
			status: "failed",
			exitCode: -1,
			aggregatedOutput: "x".repeat(70_000),
		});
		if (!command) throw new Error("fixture shape");
		expect(shellItem("s", command)).toMatchObject({
			exitCode: null,
			truncated: true,
			state: "done",
		});
	});

	test("images older than the last five turns are left out", () => {
		const turn = (id: string) => ({
			id,
			status: "completed",
			items: [
				{
					type: "mcpToolCall",
					id: `m${id}`,
					server: "s",
					tool: "t",
					status: "completed",
					arguments: {},
					result: { content: [{ type: "image", mimeType: "image/png", data: "AAAA" }] },
				},
			],
		});
		const events = replayTurns(["1", "2", "3", "4", "5", "6"].map(turn));
		const parts = events.flatMap((event) =>
			event.type === "tool.output" ? [event.part.type] : [],
		);
		expect(parts).toEqual([
			"imageOmitted",
			"image",
			"image",
			"image",
			"image",
			"image",
		]);
	});
});

describe("cards", () => {
	test("approvals offer only what Codex lists, never an exec-policy amendment", () => {
		const recorded = fixture("command-approval").find(
			(line) => line.msg.method === "item/commandExecution/requestApproval",
		);
		const available = (
			recorded?.msg.params as { availableDecisions: unknown[] } | undefined
		)?.availableDecisions;
		expect(approvalOptions(available)).toEqual([
			{ id: "accept", label: "Allow once", decision: "allowed" },
			{ id: "cancel", label: "Deny", decision: "denied" },
		]);
		expect(
			approvalOptions(["accept", "acceptForSession", "decline", "cancel"]),
		).toEqual([
			{ id: "accept", label: "Allow once", decision: "allowed" },
			{
				id: "acceptForSession",
				label: "Allow for this chat",
				decision: "allowedAlways",
			},
			{ id: "decline", label: "Deny", decision: "denied" },
		]);
		expect(approvalOptions(undefined).map((option) => option.id)).toEqual([
			"accept",
			"decline",
		]);
	});

	test("an MCP approval answers for this chat with a session grant, never always", () => {
		expect(mcpAnswer("accept")).toEqual({ action: "accept", content: {}, _meta: null });
		expect(mcpAnswer("acceptForSession")).toEqual({
			action: "accept",
			content: {},
			_meta: { persist: "session" },
		});
		expect(mcpAnswer("decline")).toEqual({
			action: "decline",
			content: null,
			_meta: null,
		});
	});

	test("a question card keeps options, header and secrecy, and answers by question id", () => {
		const recorded = fixture("plan-question").find(
			(line) => line.msg.method === "item/tool/requestUserInput",
		);
		const request = parsed(UserInputRequest, recorded?.msg.params);
		if (!request) throw new Error("fixture shape");
		const card = questionCard(request);
		expect(card).toMatchObject({
			type: "question",
			id: "call_0001",
			questions: [{ question: "<question>", header: "<header>", multiSelect: false }],
		});
		expect(card?.type === "question" && card.questions[0]?.options).toHaveLength(3);
		expect(questionAnswer(request, { "<question>": "<option label>" })).toEqual({
			answers: { language: { answers: ["<option label>"] } },
		});
		expect(questionAnswer(request, {})).toEqual({
			answers: { language: { answers: [] } },
		});
	});

	test("a free-text secret question has no options; one that does not fit has no card", () => {
		const base = { threadId: "t", itemId: "q" };
		const free = questionCard({
			...base,
			questions: [
				{
					id: "k",
					header: "Key",
					question: "Your key?",
					isSecret: true,
					options: null,
				},
			],
		});
		expect(free).toMatchObject({ questions: [{ options: [], secret: true }] });
		expect(questionCard({ ...base, questions: [] })).toBeNull();
		expect(
			questionCard({
				...base,
				questions: [{ id: "k", header: "h", question: "", options: null }],
			}),
		).toBeNull();
	});

	test("the plan card carries the plan and says what each button does", () => {
		const card = planCard("p", "1. Do it");
		expect(card.plan).toBe("1. Do it");
		expect(card.toolName).toBe("plan");
		expect(card.options.map((option) => option.decision)).toEqual([
			"allowed",
			"allowed",
			"denied",
		]);
	});
});

describe("commands and modes", () => {
	test("the chat's own commands, the dimmed terminal ones, then enabled skills with $", () => {
		const skills = parsed(SkillsList, recordedResult("skills", "skills/list"));
		const commands = codexCommands(skills);
		const runs = commands.filter((one) => !one.terminalOnly && one.prefix !== "$");
		expect(runs.map((one) => one.name)).toEqual([
			"model",
			"effort",
			"permissions",
			"plan",
			"compact",
			"new",
			"clear",
			"rename",
			"review",
			"mcp",
		]);
		expect(commands.filter((one) => one.terminalOnly).map((one) => one.name)).toEqual([
			"resume",
			"fork",
			"status",
			"diff",
			"init",
			"plugins",
			"logout",
		]);
		const skill = commands.find((one) => one.name === "probe-alpha");
		expect(skill).toEqual({
			name: "probe-alpha",
			description: "Replies with the word ALPHA.",
			terminalOnly: false,
			prefix: "$",
		});
		expect(commands.find((one) => one.name === "imagegen")?.description).toBe(
			"Generate or edit images for websites, games, and more",
		);
	});

	test("a disabled skill is left out", () => {
		const commands = codexCommands({
			data: [
				{
					skills: [
						{ name: "off", enabled: false },
						{ name: "on", enabled: true },
					],
				},
			],
		});
		expect(commands.some((one) => one.name === "off")).toBe(false);
		expect(commands.some((one) => one.name === "on")).toBe(true);
	});

	test("only the chat's own commands are run, with their argument", () => {
		expect(slashCommand("/rename  My title ")).toEqual({
			name: "rename",
			rest: "My title",
		});
		expect(slashCommand("/compact")).toEqual({ name: "compact", rest: "" });
		expect(slashCommand("/status")).toBeNull();
		expect(slashCommand("$probe-alpha go")).toBeNull();
		expect(slashCommand("please /compact")).toBeNull();
	});

	test("five modes in Claude's places with Codex's words; only Full access warns", () => {
		expect(CODEX_MODES.map((mode) => [mode.id, mode.label])).toEqual([
			["untrusted", "Ask"],
			["readOnly", "Read only"],
			["plan", "Plan"],
			["onRequest", "Auto"],
			["fullAccess", "Full access"],
		]);
		expect(CODEX_MODES.filter((mode) => mode.warning).map((mode) => mode.id)).toEqual([
			"fullAccess",
		]);
		expect(CODEX_MODES.filter((mode) => mode.plan).map((mode) => mode.id)).toEqual([
			"plan",
		]);
	});

	test("each mode is an approval policy with a sandbox; Auto uses the workspace sandbox", () => {
		const policy = (mode: Parameters<typeof modePolicy>[0]) =>
			modePolicy(mode, DEFAULT_WORKSPACE_SANDBOX);
		expect(policy("untrusted")).toMatchObject({
			approvalPolicy: "untrusted",
			sandbox: "workspace-write",
		});
		expect(policy("readOnly")).toMatchObject({
			approvalPolicy: "on-request",
			sandbox: "read-only",
		});
		expect(policy("plan")).toMatchObject({
			approvalPolicy: "on-request",
			sandbox: "workspace-write",
		});
		expect(policy("onRequest")).toEqual({
			approvalPolicy: "on-request",
			sandbox: "workspace-write",
			sandboxPolicy: DEFAULT_WORKSPACE_SANDBOX,
		});
		expect(policy("fullAccess")).toEqual({
			approvalPolicy: "never",
			sandbox: "danger-full-access",
			sandboxPolicy: { type: "dangerFullAccess" },
		});
	});
});
