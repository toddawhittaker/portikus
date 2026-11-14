import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	ChatCommand,
	ChatMcpServer,
	ChatModeInfo,
	ChatModelInfo,
	ChatOpenCard,
} from "@portikus/contracts";
import { collectingLogger } from "@portikus/observability/testing";
import { afterEach, describe, expect, test, vi } from "vitest";
import type {
	CardSettle,
	ChatEventBody,
	ChatSettings,
	ContextFigures,
} from "../agent.js";
import { chatSessionsDir } from "../session-record.js";
import { readLines } from "../wire.js";
import { FakeAppServer, Refuse, recordedResult, segment } from "./fake-app-server.js";
import {
	CodexAgent,
	CodexChatHost,
	type PostedState,
	SIGN_IN_MESSAGE,
} from "./host.js";

/** The recorded first thread of every fixture, which the stand-in also starts. */
const MAIN = "00000000-0000-7000-8000-000000000002";
const PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAEElEQVR4nGP4z8AARwzEcQCukw/x0F8jngAAAABJRU5ErkJggg==",
	"base64",
);

function threadResult(id: string) {
	return {
		thread: { id, name: null },
		model: "gpt-6.1-sol",
		reasoningEffort: "medium",
		sandbox: {
			type: "workspaceWrite",
			writableRoots: [],
			networkAccess: true,
			excludeTmpdirEnvVar: false,
			excludeSlashTmp: false,
		},
	};
}

type Handlers = ConstructorParameters<typeof FakeAppServer>[0];

function defaultHandlers(): Handlers {
	return {
		initialize: () => recordedResult("model-list", "initialize"),
		"thread/start": () => threadResult(MAIN),
		"thread/resume": (params) => threadResult(String(params.threadId)),
		"model/list": () => recordedResult("model-list", "model/list"),
		"skills/list": () => recordedResult("skills", "skills/list"),
		"mcpServerStatus/list": () =>
			recordedResult("mcp-approval", "mcpServerStatus/list"),
		"thread/turns/list": () => recordedResult("resume-turns-list", "thread/turns/list"),
		"turn/start": () => ({ turn: { id: "00000000-0000-7000-8000-000000000003" } }),
		"turn/steer": () => ({ turnId: "00000000-0000-7000-8000-000000000003" }),
		"turn/interrupt": () => ({}),
		"thread/shellCommand": () => ({}),
		"thread/name/set": () => ({}),
		"thread/compact/start": () => ({}),
		"review/start": () => ({}),
		"thread/unsubscribe": () => ({ status: "unsubscribed" }),
	};
}

interface OpenCard {
	card: ChatOpenCard;
	settle: CardSettle;
}

function recordingSink() {
	const got = {
		events: [] as ChatEventBody[],
		models: [] as ChatModelInfo[][],
		settings: [] as ChatSettings[],
		commands: [] as ChatCommand[][],
		contexts: [] as ContextFigures[],
		modes: [] as ChatModeInfo[][],
		mcp: [] as ChatMcpServer[][],
		cards: new Map<string, OpenCard>(),
		resets: 0,
	};
	const sink = {
		emit: (event: ChatEventBody) => got.events.push(event),
		models: (list: ChatModelInfo[]) => got.models.push(list),
		settings: (settings: ChatSettings) => got.settings.push(settings),
		commands: (list: ChatCommand[]) => got.commands.push(list),
		context: (figures: ContextFigures) => got.contexts.push(figures),
		rules: () => undefined,
		modes: (list: ChatModeInfo[]) => got.modes.push(list),
		mcp: (list: ChatMcpServer[]) => got.mcp.push(list),
		openCard: (card: ChatOpenCard, settle: CardSettle, signal?: AbortSignal) => {
			got.cards.set(card.id, { card, settle });
			signal?.addEventListener("abort", () => {
				if (got.cards.delete(card.id)) void settle({ type: "closed" });
			});
		},
		conversationReset: () => {
			got.resets += 1;
		},
	};
	return { sink, got };
}

let home: string | null = null;

afterEach(async () => {
	if (home)
		await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
	home = null;
});

async function setup(
	options: {
		handlers?: Partial<Handlers>;
		sessionId?: string;
		terminalId?: string;
	} = {},
) {
	home = await mkdtemp(join(tmpdir(), "portikus-codex-host-"));
	const projectDir = join(home, "projects", "demo");
	await mkdir(projectDir, { recursive: true });
	await writeFile(join(projectDir, "red.png"), PNG);
	await writeFile(join(projectDir, "logo.svg"), "<svg/>");
	const handlers = { ...defaultHandlers(), ...options.handlers } as Handlers;
	const servers: FakeAppServer[] = [];
	const titles: (string | null)[] = [];
	const states: PostedState[] = [];
	const { logger, lines } = collectingLogger();
	const terminalId = options.terminalId ?? randomUUID();
	const agent = new CodexAgent({
		terminalId,
		...(options.sessionId ? { sessionId: options.sessionId } : {}),
		projectDir,
		homeDir: home,
		socketDir: home,
		log: logger,
		postTitle: async (title) => {
			titles.push(title);
		},
		postState: async (state) => {
			states.push(state);
		},
		spawn: () => {
			const server = new FakeAppServer(handlers);
			servers.push(server);
			return server;
		},
	});
	const { sink, got } = recordingSink();
	await agent.start(sink);
	// A new thread's record is written in the background; let it land first.
	const record = join(chatSessionsDir(home), terminalId);
	if (!options.sessionId) await vi.waitFor(() => readFile(record, "utf8"));
	const server = () => servers.at(-1) as FakeAppServer;
	return { agent, got, server, servers, titles, states, lines, terminalId, projectDir };
}

/** Push recorded server traffic, stopping after the first message of this method. */
function pushUntil(
	server: FakeAppServer,
	messages: Record<string, unknown>[],
	method?: string,
): Record<string, unknown>[] {
	while (messages.length > 0) {
		const message = messages.shift() as Record<string, unknown>;
		server.push(message);
		if (method && message.method === method) break;
	}
	return messages;
}

const sameThread = { from: MAIN, to: MAIN };

function types(events: ChatEventBody[]): string[] {
	return events.map((event) => event.type);
}

describe("starting", () => {
	test("starts app-server with the experimental API and a saved thread in the project", async () => {
		const { server, got, terminalId, projectDir, lines } = await setup();
		const init = server().requests("initialize")[0];
		expect(init?.params).toMatchObject({ capabilities: { experimentalApi: true } });
		const start = server().requests("thread/start")[0]?.params;
		expect(start).toEqual({
			cwd: projectDir,
			approvalPolicy: "on-request",
			sandbox: "workspace-write",
		});
		// The tab's record now names the thread, so Resume continues it.
		await vi.waitFor(async () => {
			const recorded = await readFile(
				join(chatSessionsDir(home as string), terminalId),
				"utf8",
			);
			expect(recorded).toBe(MAIN);
		});
		expect(lines.some((line) => line.codex === "0.167.1")).toBe(true);
		expect(JSON.stringify(lines)).not.toContain(MAIN);
		expect(got.settings.at(-1)).toEqual({
			agent: "codex",
			model: "gpt-6.1-sol",
			effort: "medium",
			mode: "onRequest",
		});
	});

	test("lists the modes, the models with their efforts, the commands with skills, and MCP", async () => {
		const { got, server } = await setup();
		expect(got.modes[0]?.map((mode) => mode.label)).toEqual([
			"Ask",
			"Read only",
			"Plan",
			"Auto",
			"Full access",
		]);
		expect(got.models.at(-1)?.[0]).toMatchObject({
			value: "gpt-6.1-sol",
			displayName: "GPT-6.1-Sol",
			efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
			defaultEffort: "low",
		});
		await vi.waitFor(() => {
			expect(
				got.commands.at(-1)?.find((one) => one.name === "probe-alpha")?.prefix,
			).toBe("$");
			expect(got.mcp.at(-1)).toEqual([{ name: "echo", status: "connected" }]);
		});
		const methods = server().sent.map((message) => message.method);
		for (const never of ["account/read", "plugin/list", "app/list"]) {
			expect(methods).not.toContain(never);
		}
		const params = JSON.stringify(server().sent);
		expect(params).not.toContain("developerInstructions");
	});

	test("resumes the tab's thread, and replays its last turns", async () => {
		const { server, got, agent } = await setup({ sessionId: MAIN });
		expect(server().requests("thread/start")).toHaveLength(0);
		expect(server().requests("thread/resume")[0]?.params).toMatchObject({
			threadId: MAIN,
			excludeTurns: true,
		});
		const history = await agent.history(false);
		expect(types(history.events)).toEqual([
			"turn.started",
			"message",
			"message",
			"turn.finished",
		]);
		expect(history.truncated).toBe(false);
		expect(server().requests("thread/turns/list")[0]?.params).toMatchObject({
			threadId: MAIN,
			limit: 20,
			itemsView: "full",
		});
		expect(got.events).toEqual([]);
	});

	test("starts a fresh thread when the recorded one cannot be resumed", async () => {
		const { server } = await setup({
			sessionId: randomUUID(),
			handlers: { "thread/resume": () => new Refuse("no rollout") },
		});
		expect(server().requests("thread/start")).toHaveLength(1);
	});

	test("an unreadable history replays nothing", async () => {
		const { agent } = await setup({
			handlers: { "thread/turns/list": () => new Refuse("not saved yet") },
		});
		expect((await agent.history(false)).events).toEqual([]);
	});
});

describe("a turn", () => {
	test("sends the message with the mode's policy, then streams Codex's reply and context", async () => {
		const { agent, server, got } = await setup();
		await agent.send("hello", []);
		const start = server().requests("turn/start")[0]?.params;
		expect(start).toMatchObject({
			threadId: MAIN,
			input: [{ type: "text", text: "hello", text_elements: [] }],
			approvalPolicy: "on-request",
			sandboxPolicy: { type: "workspaceWrite", networkAccess: true },
			model: "gpt-6.1-sol",
			effort: "medium",
		});
		expect(start).not.toHaveProperty("collaborationMode");
		pushUntil(server(), segment("token-usage", "turn/start", 0, sameThread));
		await vi.waitFor(() => expect(types(got.events).at(-1)).toBe("turn.finished"));
		expect(types(got.events)).toEqual([
			"message",
			"turn.started",
			"text.delta",
			"message",
			"turn.finished",
		]);
		expect(got.events[0]).toMatchObject({ role: "user", markdown: "hello" });
		expect(got.events.at(-1)).toMatchObject({ status: "done" });
		expect(got.contexts.at(-1)).toEqual({
			usedTokens: 14744,
			windowTokens: 475000,
			cache: null,
		});
	});

	test("an image is handed over by path, and the message names it", async () => {
		const { agent, server, projectDir } = await setup();
		await agent.send("what is this", [{ path: "red.png" }]);
		expect(server().requests("turn/start")[0]?.params?.input).toEqual([
			{
				type: "text",
				text: "what is this\n\nAttached file: red.png",
				text_elements: [],
			},
			{ type: "localImage", path: join(projectDir, "red.png") },
		]);
		await expect(agent.send("x", [{ path: "logo.svg" }])).rejects.toThrow("SVG");
		await expect(agent.send("x", [{ path: "missing.png" }])).rejects.toThrow();
	});

	test("a message while Codex works steers the running turn", async () => {
		const { agent, server, got } = await setup();
		await agent.send("first", []);
		pushUntil(server(), segment("steer", "turn/start", 0, sameThread), "turn/started");
		await agent.send("also this", []);
		expect(server().requests("turn/steer")[0]?.params).toMatchObject({
			threadId: MAIN,
			input: [{ type: "text", text: "also this" }],
			expectedTurnId: "00000000-0000-7000-8000-000000000003",
		});
		expect(got.events.filter((event) => event.type === "message")).toHaveLength(2);
		expect(types(got.events).filter((type) => type === "turn.started")).toHaveLength(1);
	});

	test("a steer Codex refuses says to wait", async () => {
		const { agent, server } = await setup({
			handlers: { "turn/steer": () => new Refuse("activeTurnNotSteerable") },
		});
		await agent.send("first", []);
		pushUntil(server(), segment("steer", "turn/start", 0, sameThread), "turn/started");
		await expect(agent.send("more", [])).rejects.toThrow("cannot take a message");
	});

	test("Stop interrupts the turn, which ends interrupted", async () => {
		const { agent, server, got } = await setup();
		await agent.send("go", []);
		const rest = pushUntil(
			server(),
			segment("interrupt", "turn/start", 0, sameThread),
			"turn/started",
		);
		await vi.waitFor(() => expect(types(got.events)).toContain("turn.started"));
		await agent.interrupt();
		expect(server().requests("turn/interrupt")[0]?.params).toEqual({
			threadId: MAIN,
			turnId: "00000000-0000-7000-8000-000000000003",
		});
		pushUntil(server(), [
			...rest,
			...segment("interrupt", "turn/interrupt", 0, sameThread),
		]);
		await vi.waitFor(() =>
			expect(got.events.at(-1)).toMatchObject({
				type: "turn.finished",
				status: "interrupted",
			}),
		);
	});

	test("a turn Codex refuses to start ends at once with the reason", async () => {
		const { agent, got } = await setup({
			handlers: { "turn/start": () => new Refuse("model not found") },
		});
		await expect(agent.send("go", [])).rejects.toThrow("model not found");
		expect(got.events.at(-1)).toMatchObject({ type: "turn.finished", status: "error" });
	});

	test("an unauthorized turn says how to sign in, once", async () => {
		const { agent, server, got } = await setup();
		await agent.send("go", []);
		const turn = {
			id: "t1",
			status: "failed",
			error: { message: "401", codexErrorInfo: "unauthorized" },
		};
		server().push({
			method: "turn/started",
			params: { threadId: MAIN, turn: { id: "t1", status: "inProgress" } },
		});
		server().push({
			method: "error",
			params: { threadId: MAIN, turnId: "t1", willRetry: false, error: turn.error },
		});
		server().push({ method: "turn/completed", params: { threadId: MAIN, turn } });
		await vi.waitFor(() => expect(types(got.events).at(-1)).toBe("turn.finished"));
		const errors = got.events.filter((event) => event.type === "error");
		expect(errors).toEqual([{ type: "error", message: SIGN_IN_MESSAGE }]);
	});

	test("a failed turn with no error event still shows its error; a retry shows none", async () => {
		const { agent, server, got } = await setup();
		await agent.send("go", []);
		server().push({
			method: "error",
			params: { threadId: MAIN, willRetry: true, error: { message: "retrying" } },
		});
		server().push({
			method: "turn/completed",
			params: {
				threadId: MAIN,
				turn: { id: "t", status: "failed", error: { message: "Usage limit reached" } },
			},
		});
		await vi.waitFor(() => expect(types(got.events).at(-1)).toBe("turn.finished"));
		expect(got.events.filter((event) => event.type === "error")).toEqual([
			{ type: "error", message: "Usage limit reached" },
		]);
	});

	test("the conversation title follows Codex's thread name", async () => {
		const { server, titles } = await setup();
		server().push({
			method: "thread/name/updated",
			params: { threadId: MAIN, threadName: "Fix tests" },
		});
		await vi.waitFor(() => expect(titles.at(-1)).toBe("Fix tests"));
	});
});

describe("approvals", () => {
	test("a command approval is a card with Codex's own decisions; Allow answers accept", async () => {
		const { agent, server, got } = await setup();
		await agent.send("run ls", []);
		const traffic = segment("command-approval", "turn/start", 0, sameThread);
		pushUntil(server(), traffic, "item/commandExecution/requestApproval");
		await vi.waitFor(() => expect(got.cards.size).toBe(1));
		const [open] = [...got.cards.values()];
		expect(open?.card).toMatchObject({
			type: "permission",
			id: "exec-00000000-0000-7000-8000-000000000005",
			toolName: "commandExecution",
			title: "Allow Codex to run ls?",
			input: { command: "ls", actions: [{ type: "listFiles", path: null }] },
			options: [
				{ id: "accept", decision: "allowed" },
				{ id: "cancel", decision: "denied" },
			],
		});
		const outcome = await open?.settle({ type: "permission", optionId: "accept" });
		expect(outcome).toEqual({ decision: "allowed" });
		expect(server().reply(0)?.result).toEqual({ decision: "accept" });
		pushUntil(server(), traffic);
		await vi.waitFor(() => expect(types(got.events).at(-1)).toBe("turn.finished"));
	});

	test("Deny with a reason cancels, and the reason is sent once the turn ends", async () => {
		const { agent, server, got } = await setup();
		await agent.send("run ls", []);
		const traffic = segment("command-approval", "turn/start", 2, {
			from: "00000000-0000-7000-8000-000000000010",
			to: MAIN,
		});
		pushUntil(server(), traffic, "item/commandExecution/requestApproval");
		await vi.waitFor(() => expect(got.cards.size).toBe(1));
		const [open] = [...got.cards.values()];
		await open?.settle({
			type: "permission",
			optionId: "cancel",
			message: "Use git ls-files",
		});
		expect(server().reply(2)?.result).toEqual({ decision: "cancel" });
		expect(server().requests("turn/steer")).toHaveLength(0);
		pushUntil(server(), traffic);
		await vi.waitFor(() => expect(server().requests("turn/start")).toHaveLength(2));
		expect(server().requests("turn/start")[1]?.params?.input).toEqual([
			{ type: "text", text: "Use git ls-files", text_elements: [] },
		]);
		expect(got.events.filter((event) => event.type === "message").at(-1)).toMatchObject(
			{
				role: "user",
				markdown: "Use git ls-files",
			},
		);
	});

	test("a Deny reason after decline steers the running turn", async () => {
		const { agent, server, got } = await setup();
		await agent.send("run ls", []);
		server().push({
			method: "turn/started",
			params: { threadId: MAIN, turn: { id: "t", status: "inProgress" } },
		});
		server().push({
			method: "item/commandExecution/requestApproval",
			id: 7,
			params: {
				threadId: MAIN,
				turnId: "t",
				itemId: "c1",
				command: "/bin/bash -lc 'rm -rf x'",
				availableDecisions: ["accept", "acceptForSession", "decline"],
			},
		});
		await vi.waitFor(() => expect(got.cards.size).toBe(1));
		const card = got.cards.get("c1");
		expect(card?.card).toMatchObject({ title: "Allow Codex to run rm -rf x?" });
		expect(
			card?.card.type === "permission" &&
				card.card.options.map((option) => option.label),
		).toEqual(["Allow once", "Allow for this chat", "Deny"]);
		await card?.settle({
			type: "permission",
			optionId: "decline",
			message: "Not that",
		});
		expect(server().reply(7)?.result).toEqual({ decision: "decline" });
		await vi.waitFor(() =>
			expect(server().requests("turn/steer")[0]?.params?.input).toEqual([
				{ type: "text", text: "Not that", text_elements: [] },
			]),
		);
	});

	test("a file change approval shows the diff; a card Codex withdraws closes unanswered", async () => {
		const { agent, server, got } = await setup();
		await agent.send("make a file", []);
		const traffic = segment("file-change-approval", "turn/start", 0, sameThread);
		pushUntil(server(), traffic, "item/fileChange/requestApproval");
		await vi.waitFor(() => expect(got.cards.size).toBe(1));
		const [open] = [...got.cards.values()];
		expect(open?.card).toMatchObject({
			toolName: "fileChange",
			title: "Allow Codex to change /workspace/project/note.txt?",
			input: { changes: [{ kind: "add", diff: "@@ -0,0 +1,1 @@\n+<line>\n" }] },
		});
		expect(
			open?.card.type === "permission" && open.card.options.map((option) => option.id),
		).toEqual(["accept", "decline"]);
		server().push({
			method: "serverRequest/resolved",
			params: { threadId: MAIN, requestId: 0 },
		});
		await vi.waitFor(() => expect(got.cards.size).toBe(0));
		expect(server().reply(0)).toBeUndefined();
	});

	test("an approval for an item not seen yet still shows the command", async () => {
		const { agent, server, got } = await setup();
		await agent.send("go", []);
		server().push({
			method: "item/commandExecution/requestApproval",
			id: 3,
			params: {
				threadId: MAIN,
				turnId: "t",
				itemId: "x1",
				command: "/bin/bash -lc pwd",
				commandActions: [],
			},
		});
		await vi.waitFor(() =>
			expect(got.cards.get("x1")?.card).toMatchObject({
				title: "Allow Codex to run pwd?",
			}),
		);
		await got.cards.get("x1")?.settle({ type: "closed" });
		expect(server().reply(3)?.result).toEqual({ decision: "decline" });
	});

	test("an MCP tool approval is an ordinary card; for this chat is a session grant", async () => {
		const { agent, server, got } = await setup();
		await agent.send("echo hi", []);
		const traffic = segment("mcp-approval", "turn/start", 1, {
			from: "00000000-0000-7000-8000-000000000006",
			to: MAIN,
		});
		pushUntil(server(), traffic, "mcpServer/elicitation/request");
		await vi.waitFor(() => expect(got.cards.size).toBe(1));
		const [open] = [...got.cards.values()];
		expect(open?.card).toMatchObject({
			id: "exec-00000000-0000-7000-8000-000000000009",
			toolName: "mcpToolCall",
			title: "Allow echo to run echo_word?",
			input: { server: "echo", tool: "echo_word", arguments: { word: "hi" } },
		});
		expect(
			open?.card.type === "permission" &&
				open.card.options.map((option) => option.label),
		).toEqual(["Allow once", "Allow for this chat", "Deny"]);
		expect(
			await open?.settle({ type: "permission", optionId: "acceptForSession" }),
		).toEqual({
			decision: "allowedAlways",
		});
		expect(server().reply(1)?.result).toEqual({
			action: "accept",
			content: {},
			_meta: { persist: "session" },
		});
	});

	test("denying an MCP tool declines it, and closing the card does too", async () => {
		const { agent, server, got } = await setup();
		await agent.send("echo hi", []);
		const request = {
			method: "mcpServer/elicitation/request",
			params: {
				threadId: MAIN,
				serverName: "echo",
				mode: "form",
				_meta: { codex_approval_kind: "mcp_tool_call", tool_name: "echo_word" },
			},
		};
		server().push({ ...request, id: 4 });
		server().push({ ...request, id: 5 });
		await vi.waitFor(() => expect(got.cards.size).toBe(2));
		await got.cards
			.get("mcp-4")
			?.settle({ type: "permission", optionId: "decline", message: "no" });
		await got.cards.get("mcp-5")?.settle({ type: "closed" });
		const declined = { action: "decline", content: null, _meta: null };
		expect(server().reply(4)?.result).toEqual(declined);
		expect(server().reply(5)?.result).toEqual(declined);
	});

	test("any other MCP request for input is declined with a line saying where to answer it", async () => {
		const { server, got } = await setup();
		server().push({
			method: "mcpServer/elicitation/request",
			id: 9,
			params: {
				threadId: MAIN,
				serverName: "s",
				mode: "form",
				_meta: null,
				message: "Your name?",
			},
		});
		await vi.waitFor(() => expect(server().reply(9)).toBeDefined());
		expect(server().reply(9)?.result).toEqual({
			action: "decline",
			content: null,
			_meta: null,
		});
		expect(got.events).toContainEqual({
			type: "error",
			message: "An MCP server asked for input. Use a terminal tab to answer it.",
		});
		expect(got.cards.size).toBe(0);
	});

	test("tool calls, permission requests and unknown requests are declined", async () => {
		const { server } = await setup();
		server().push({ method: "item/tool/call", id: 11, params: { threadId: MAIN } });
		server().push({
			method: "item/permissions/requestApproval",
			id: 12,
			params: { threadId: MAIN },
		});
		server().push({ method: "account/chatgptAuthTokens/refresh", id: 13, params: {} });
		server().push({ method: "currentTime/read", id: 14, params: {} });
		await vi.waitFor(() => expect(server().reply(14)).toBeDefined());
		expect(server().reply(11)?.result).toEqual({ contentItems: [], success: false });
		expect(server().reply(12)?.result).toEqual({ permissions: {}, scope: "turn" });
		expect(server().reply(13)?.error).toMatchObject({ code: -32601 });
		expect(server().reply(14)?.result).toMatchObject({
			currentTimeAt: expect.any(Number),
		});
	});
});

describe("Plan mode and questions", () => {
	test("a Plan turn asks its question, marks needs-input, then offers the plan", async () => {
		const { agent, server, got, states } = await setup();
		await agent.set({ mode: "plan" });
		await agent.send("plan it", []);
		expect(server().requests("turn/start")[0]?.params?.collaborationMode).toEqual({
			mode: "plan",
			settings: {
				model: "gpt-6.1-sol",
				reasoning_effort: "medium",
				developer_instructions: null,
			},
		});
		const traffic = segment("plan-question", "turn/start", 0, sameThread);
		pushUntil(server(), traffic, "item/tool/requestUserInput");
		await vi.waitFor(() => expect(got.cards.get("call_0001")).toBeDefined());
		expect(states).toEqual(["needs-input"]);
		const question = got.cards.get("call_0001");
		await question?.settle({
			type: "question",
			answers: { "<question>": "<option label>" },
		});
		expect(server().reply(0)?.result).toEqual({
			answers: { language: { answers: ["<option label>"] } },
		});
		expect(states).toEqual(["needs-input", "working"]);
		pushUntil(server(), traffic);
		await vi.waitFor(() =>
			expect(got.cards.get("00000000-0000-7000-8000-000000000003-plan")).toBeDefined(),
		);
		expect(got.events).toContainEqual({
			type: "message",
			id: "00000000-0000-7000-8000-000000000003-plan",
			role: "assistant",
			markdown: "<text>",
		});
		const plan = got.cards.get("00000000-0000-7000-8000-000000000003-plan");
		expect(plan?.card).toMatchObject({ toolName: "plan", plan: "<text>" });
		expect(states.at(-1)).toBe("needs-input");
		expect(
			await plan?.settle({ type: "permission", optionId: "implement-ask" }),
		).toEqual({
			decision: "allowed",
		});
		expect(got.settings.at(-1)?.mode).toBe("untrusted");
		await vi.waitFor(() => expect(server().requests("turn/start")).toHaveLength(2));
		const implement = server().requests("turn/start")[1]?.params;
		expect(implement).toMatchObject({
			input: [{ type: "text", text: "Implement the plan." }],
			approvalPolicy: "untrusted",
			collaborationMode: { mode: "default" },
		});
	});

	test("keep planning sends what to plan instead, or marks the tab finished", async () => {
		const { agent, server, got, states } = await setup();
		await agent.set({ mode: "plan" });
		for (const message of ["Use Rust", undefined]) {
			await agent.send("plan", []);
			server().push({
				method: "turn/started",
				params: { threadId: MAIN, turn: { id: "t", status: "inProgress" } },
			});
			server().push({
				method: "item/completed",
				params: { threadId: MAIN, item: { type: "plan", id: "p", text: "1. Go" } },
			});
			server().push({
				method: "turn/completed",
				params: { threadId: MAIN, turn: { id: "t", status: "completed" } },
			});
			await vi.waitFor(() => expect(got.cards.get("p")).toBeDefined());
			const card = got.cards.get("p");
			got.cards.delete("p");
			await card?.settle({ type: "permission", optionId: "keep-planning", message });
			if (message) {
				await vi.waitFor(() =>
					expect(
						got.events.filter((event) => event.type === "message").at(-1),
					).toMatchObject({
						markdown: "Use Rust",
					}),
				);
				server().push({
					method: "turn/completed",
					params: { threadId: MAIN, turn: { id: "t", status: "interrupted" } },
				});
				await vi.waitFor(() => expect(types(got.events).at(-1)).toBe("turn.finished"));
			}
		}
		expect(states.at(-1)).toBe("finished");
		expect(got.settings.at(-1)?.mode).toBe("plan");
	});

	test("a question the card cannot show is skipped with a line saying so", async () => {
		const { server, got } = await setup();
		server().push({
			method: "item/tool/requestUserInput",
			id: 20,
			params: { threadId: MAIN, turnId: "t", itemId: "q", questions: [] },
		});
		await vi.waitFor(() => expect(server().reply(20)?.result).toEqual({ answers: {} }));
		expect(got.events.at(-1)).toMatchObject({ type: "error" });
	});
});

describe("subagents", () => {
	test("a child thread's events never end or fill the main turn; the spawn row names it", async () => {
		const { agent, server, got } = await setup();
		await agent.send("spawn one", []);
		pushUntil(server(), segment("subagent", "turn/start", 0, sameThread));
		await vi.waitFor(() => expect(types(got.events).at(-1)).toBe("turn.finished"));
		expect(types(got.events).filter((type) => type === "turn.finished")).toHaveLength(
			1,
		);
		const spawn = got.events.find((event) => event.type === "tool.started");
		expect(spawn).toMatchObject({
			name: "collabAgentToolCall",
			input: {
				tool: "spawnAgent",
				receivers: ["00000000-0000-7000-8000-000000000005"],
			},
		});
		// The child's own reply is not in the main conversation.
		expect(
			got.events.some((event) => event.type === "message" && event.id === "msg_0004"),
		).toBe(false);
	});

	test("the subagent panel replays the child thread, then follows it live", async () => {
		const child = "00000000-0000-7000-8000-000000000005";
		const { agent, server } = await setup();
		const written: string[] = [];
		const socket = {
			destroyed: false,
			write: (line: string) => written.push(line),
		} as unknown as Socket;
		await agent.watchSubagent(socket, child);
		expect(server().requests("thread/turns/list").at(-1)?.params).toMatchObject({
			threadId: child,
		});
		await agent.send("spawn", []);
		const traffic = segment("subagent", "turn/start", 0, sameThread);
		pushUntil(server(), traffic);
		await vi.waitFor(() => expect(written.length).toBeGreaterThan(6));
		const frames = written.map((line) => JSON.parse(line));
		expect(
			frames.every((frame) => frame.type === "subagent" && frame.toolUseId === child),
		).toBe(true);
		expect(frames.map((frame) => frame.event.seq)).toEqual(
			frames.map((_, index) => index),
		);
		const kinds = frames.map((frame) => frame.event.type);
		expect(kinds[0]).toBe("snapshot");
		expect(kinds).toContain("message");
		expect(
			kinds.filter((kind) => kind === "turn.finished").length,
		).toBeGreaterThanOrEqual(2);
		agent.unwatchSubagent(socket, child);
		const count = written.length;
		server().push({
			method: "turn/started",
			params: { threadId: child, turn: { id: "x", status: "inProgress" } },
		});
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(written).toHaveLength(count);
	});

	test("an approval a subagent asks for shows on the main chat", async () => {
		const child = "00000000-0000-7000-8000-0000000000c1";
		const { server, got } = await setup();
		server().push({
			method: "item/started",
			params: {
				threadId: child,
				item: {
					type: "commandExecution",
					id: "cc",
					command: "make",
					status: "inProgress",
					commandActions: [],
				},
			},
		});
		server().push({
			method: "item/commandExecution/requestApproval",
			id: 30,
			params: {
				threadId: child,
				turnId: "t",
				itemId: "cc",
				availableDecisions: ["accept", "decline"],
			},
		});
		await vi.waitFor(() =>
			expect(got.cards.get("cc")?.card).toMatchObject({
				title: "Allow Codex to run make?",
			}),
		);
	});
});

describe("! commands", () => {
	test("runs through Codex's shell command, shown as a shell item, never as a turn", async () => {
		const { agent, server, got } = await setup();
		await agent.send("!echo hi", []);
		expect(server().requests("thread/shellCommand")[0]?.params).toEqual({
			threadId: MAIN,
			command: "echo hi",
			timeoutMs: 120_000,
		});
		expect(agent.inProgress()).toMatchObject([{ type: "shell", state: "running" }]);
		await expect(agent.send("another", [])).rejects.toThrow(
			"Wait for the shell command",
		);
		pushUntil(server(), segment("shell-command", "thread/shellCommand", 0, sameThread));
		await vi.waitFor(() =>
			expect(got.events.at(-1)).toMatchObject({ type: "shell", state: "done" }),
		);
		expect(types(got.events)).toEqual(["shell", "shell"]);
		expect(got.events.at(-1)).toMatchObject({
			command: "echo hi",
			output: "<output>\n",
			exitCode: 0,
		});
		expect(got.events[0]).toMatchObject({ id: (got.events[1] as { id: string }).id });
		expect(agent.inProgress()).toEqual([]);
	});

	test("Stop interrupts the shell command's turn; it ends with no exit code", async () => {
		const { agent, server, got } = await setup();
		await agent.send("!sleep 30", []);
		const traffic = segment("shell-command", "thread/shellCommand", 1, sameThread);
		pushUntil(server(), traffic, "item/started");
		await vi.waitFor(() => expect(server().sent.length).toBeGreaterThan(0));
		await agent.interrupt();
		expect(server().requests("turn/interrupt")[0]?.params).toEqual({
			threadId: MAIN,
			turnId: "00000000-0000-7000-8000-000000000005",
		});
		pushUntil(server(), [
			...traffic,
			...segment("shell-command", "turn/interrupt", 0, sameThread),
		]);
		await vi.waitFor(() =>
			expect(got.events.at(-1)).toMatchObject({ type: "shell", state: "done" }),
		);
		expect(got.events.at(-1)).toMatchObject({ exitCode: null });
		expect(types(got.events)).not.toContain("turn.finished");
	});

	test("refused while Codex works, with attachments, or when Codex cannot start it", async () => {
		const { agent, got } = await setup({
			handlers: { "thread/shellCommand": () => new Refuse("no") },
		});
		await expect(agent.send("!ls", [{ path: "red.png" }])).rejects.toThrow(
			"attachments",
		);
		await expect(agent.send("!ls", [])).rejects.toThrow("could not start");
		expect(got.events.at(-1)).toMatchObject({ type: "shell", state: "done" });
		await agent.send("go", []);
		await expect(agent.send("!ls", [])).rejects.toThrow("while Codex is working");
	});
});

describe("settings and commands", () => {
	test("a model, effort or mode change is kept for the next turn", async () => {
		const { agent, server, got } = await setup();
		await agent.set({ model: "gpt-6-astra", effort: "xhigh", mode: "fullAccess" });
		expect(got.settings.at(-1)).toEqual({
			agent: "codex",
			model: "gpt-6-astra",
			effort: "xhigh",
			mode: "fullAccess",
		});
		await agent.send("go", []);
		expect(server().requests("turn/start")[0]?.params).toMatchObject({
			model: "gpt-6-astra",
			effort: "xhigh",
			approvalPolicy: "never",
			sandboxPolicy: { type: "dangerFullAccess" },
		});
	});

	test("an effort the model does not offer is refused; an unknown mode too", async () => {
		const { agent, got } = await setup();
		await expect(agent.set({ effort: "turbo" })).rejects.toThrow("does not offer");
		await expect(agent.set({ mode: "bypassPermissions" })).rejects.toThrow("no such");
		expect(got.settings.at(-1)?.effort).toBe("medium");
	});

	test("a model without the effort in force takes the model's default", async () => {
		const { agent, got, server } = await setup({
			handlers: {
				"model/list": () => ({
					data: [
						{
							id: "a",
							displayName: "A",
							supportedReasoningEfforts: [{ reasoningEffort: "medium" }],
						},
						{
							id: "b",
							displayName: "B",
							supportedReasoningEfforts: [
								{ reasoningEffort: "low" },
								{ reasoningEffort: "high" },
							],
							defaultReasoningEffort: "high",
						},
						{ id: "hidden", displayName: "H", hidden: true },
						{ id: "Bad Name", displayName: "X" },
					],
				}),
			},
		});
		expect(got.models.at(-1)?.map((model) => model.value)).toEqual(["a", "b"]);
		await agent.set({ model: "b" });
		expect(got.settings.at(-1)).toMatchObject({ model: "b", effort: "high" });
		expect(server().requests("model/list")).toHaveLength(1);
	});

	test("/model, /effort, /permissions and /plan set the pickers", async () => {
		const { agent, got } = await setup();
		await agent.send("/model gpt-6-astra", []);
		await agent.send("/effort high", []);
		await agent.send("/permissions read only", []);
		expect(got.settings.at(-1)).toMatchObject({
			model: "gpt-6-astra",
			effort: "high",
			mode: "readOnly",
		});
		await agent.send("/permissions fullAccess", []);
		expect(got.settings.at(-1)?.mode).toBe("fullAccess");
		await expect(agent.send("/model", [])).rejects.toThrow("Model picker");
		await expect(agent.send("/effort", [])).rejects.toThrow("Effort picker");
		await expect(agent.send("/permissions maybe", [])).rejects.toThrow(
			"Permissions picker",
		);
		await agent.send("/plan", []);
		expect(got.settings.at(-1)?.mode).toBe("plan");
		expect(types(got.events)).toEqual([]);
	});

	test("/plan with a prompt plans it at once", async () => {
		const { agent, server } = await setup();
		await agent.send("/plan add a cache", []);
		expect(server().requests("turn/start")[0]?.params).toMatchObject({
			input: [{ type: "text", text: "add a cache" }],
			collaborationMode: { mode: "plan" },
		});
	});

	test("/rename and the pencil retitle the thread and post the title", async () => {
		const { agent, server, titles } = await setup();
		await agent.send("/rename  Tidy up ", []);
		expect(server().requests("thread/name/set")[0]?.params).toEqual({
			threadId: MAIN,
			name: "Tidy up",
		});
		expect(titles.at(-1)).toBe("Tidy up");
		expect(await agent.rename("Again")).toEqual({ type: "rename.result", ok: true });
		await expect(agent.send("/rename", [])).rejects.toThrow("Type the new title");
	});

	test("a rename Codex refuses is reported", async () => {
		const { agent } = await setup({
			handlers: { "thread/name/set": () => new Refuse("nope") },
		});
		expect(await agent.rename("X")).toMatchObject({ ok: false });
		await expect(agent.send("/rename X", [])).rejects.toThrow();
	});

	test("/compact and /review start Codex's own turns", async () => {
		const { agent, server, got } = await setup();
		await agent.send("/compact", []);
		expect(server().requests("thread/compact/start")[0]?.params).toEqual({
			threadId: MAIN,
		});
		await agent.send("/review", []);
		await agent.send("/review focus on tests", []);
		expect(
			server()
				.requests("review/start")
				.map((request) => request.params?.target),
		).toEqual([
			{ type: "uncommittedChanges" },
			{ type: "custom", instructions: "focus on tests" },
		]);
		expect(got.events.filter((event) => event.type === "message")).toHaveLength(3);
		server().push({
			method: "turn/started",
			params: { threadId: MAIN, turn: { id: "r", status: "inProgress" } },
		});
		await vi.waitFor(() => expect(types(got.events)).toContain("turn.started"));
		await expect(agent.send("/compact", [])).rejects.toThrow("Wait for Codex");
	});

	test("/new starts a fresh thread, records it, and resets every view", async () => {
		const other = "00000000-0000-7000-8000-0000000000b2";
		let started = 0;
		const { agent, server, got, terminalId } = await setup({
			handlers: {
				"thread/start": () => threadResult(started++ === 0 ? MAIN : other),
			},
		});
		await agent.send("/new", []);
		expect(server().requests("thread/unsubscribe")[0]?.params).toEqual({
			threadId: MAIN,
		});
		expect(got.resets).toBe(1);
		await vi.waitFor(async () => {
			const recorded = await readFile(
				join(chatSessionsDir(home as string), terminalId),
				"utf8",
			);
			expect(recorded).toBe(other);
		});
		await agent.send("/clear", []);
		expect(got.resets).toBe(2);
	});

	test("/mcp reads the servers again, and startup updates change their status", async () => {
		const { agent, server, got } = await setup();
		await vi.waitFor(() => expect(got.mcp.length).toBeGreaterThan(0));
		await agent.send("/mcp", []);
		expect(server().requests("mcpServerStatus/list").length).toBeGreaterThanOrEqual(2);
		server().push({
			method: "mcpServer/startupStatus/updated",
			params: { threadId: MAIN, name: "echo", status: "failed" },
		});
		server().push({
			method: "mcpServer/startupStatus/updated",
			params: { threadId: MAIN, name: "codex_apps", status: "failed" },
		});
		server().push({
			method: "mcpServer/startupStatus/updated",
			params: { threadId: null, name: "docs", status: "starting" },
		});
		await vi.waitFor(() =>
			expect(got.mcp.at(-1)).toEqual([
				{ name: "echo", status: "failed" },
				{ name: "docs", status: "starting" },
			]),
		);
	});

	test("MCP statuses are worded as the chat lists them", async () => {
		const { got } = await setup({
			handlers: {
				"mcpServerStatus/list": () => ({
					data: [
						{ name: "a", runtimeStatus: "authenticationRequired" },
						{ name: "b", runtimeStatus: "disabled" },
						{ name: "c", runtimeStatus: "cancelled" },
						{ name: "d", runtimeStatus: null, authStatus: "notLoggedIn" },
						{ name: "e", runtimeStatus: "notStarted" },
					],
					nextCursor: null,
				}),
			},
		});
		await vi.waitFor(() =>
			expect(got.mcp.at(-1)?.map((server) => server.status)).toEqual([
				"needsAuth",
				"disabled",
				"failed",
				"needsAuth",
				"starting",
			]),
		);
	});

	test("skills are read again when Codex says they changed", async () => {
		const { server } = await setup();
		server().push({ method: "skills/changed", params: {} });
		await vi.waitFor(() => expect(server().requests("skills/list")).toHaveLength(2));
		expect(server().requests("skills/list")[1]?.params).toMatchObject({
			forceReload: true,
		});
	});
});

describe("when app-server stops", () => {
	test("the chat says so, closes its cards, and the next message starts it again", async () => {
		const { agent, servers, server, got } = await setup();
		await agent.send("go", []);
		server().push({
			method: "item/fileChange/requestApproval",
			id: 40,
			params: { threadId: MAIN, turnId: "t", itemId: "f" },
		});
		await vi.waitFor(() => expect(got.cards.size).toBe(1));
		server().exit();
		await vi.waitFor(() => expect(got.cards.size).toBe(0));
		expect(got.events.slice(-2)).toEqual([
			expect.objectContaining({ type: "turn.finished", status: "error" }),
			{ type: "error", message: "Codex stopped. Send a message to resume." },
		]);
		await agent.send("again", []);
		expect(servers).toHaveLength(2);
		expect(server().requests("thread/resume")[0]?.params).toMatchObject({
			threadId: MAIN,
		});
	});

	test("an app-server that fails to start leaves the chat open, and a send tries again", async () => {
		let attempts = 0;
		const { agent, servers, got } = await setup({
			sessionId: MAIN,
			handlers: {
				initialize: () =>
					attempts++ === 0
						? new Refuse("bad config")
						: recordedResult("model-list", "initialize"),
			},
		});
		expect(got.settings).toEqual([]);
		expect(got.modes).toHaveLength(1);
		await agent.send("hello", []);
		expect(servers).toHaveLength(2);
		expect(got.settings.at(-1)).toMatchObject({ agent: "codex", model: "gpt-6.1-sol" });
	});

	test("a send says so when app-server will not start", async () => {
		const { agent } = await setup({
			sessionId: MAIN,
			handlers: {
				"thread/resume": () => new Refuse("x"),
				"thread/start": () => ({ nope: 1 }),
			},
		});
		await expect(agent.send("hello", [])).rejects.toThrow("Codex could not start");
	});

	test("stopping the host ends app-server quietly", async () => {
		const { agent, got } = await setup();
		await agent.stop();
		expect(got.events).toEqual([]);
		expect(await agent.history(false)).toMatchObject({ events: [] });
		await agent.interrupt();
		await agent.revokeRule("x");
	});
});

describe("through the chat core", () => {
	test("a browser attaches, sees the Codex chat, sends, and answers a question", async () => {
		home = await mkdtemp(join(tmpdir(), "pk-codex-core-"));
		const projectDir = join(home, "projects", "demo");
		await mkdir(projectDir, { recursive: true });
		const servers: FakeAppServer[] = [];
		const host = new CodexChatHost({
			terminalId: randomUUID(),
			sessionId: MAIN,
			projectDir,
			homeDir: home,
			socketDir: join(home, "sock"),
			log: collectingLogger().logger,
			postTitle: async () => undefined,
			postState: async () => undefined,
			spawn: () => {
				const server = new FakeAppServer(defaultHandlers());
				servers.push(server);
				return server;
			},
		});
		await host.start();
		try {
			const socket = connect(host.socketPath);
			const frames: Record<string, unknown>[] = [];
			readLines(socket, 16 * 1024 * 1024, (line) => frames.push(JSON.parse(line)));
			await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
			await vi.waitFor(() =>
				expect(frames.map((frame) => frame.type)).toContain("mcp"),
			);
			const kinds = frames.map((frame) => frame.type);
			expect(kinds.slice(0, 5)).toEqual([
				"snapshot",
				"turn.started",
				"message",
				"message",
				"turn.finished",
			]);
			expect(kinds.slice(5)).toEqual([
				"models",
				"modes",
				"settings",
				"rules",
				"commands",
				"mcp",
			]);
			expect(frames.find((frame) => frame.type === "settings")).toMatchObject({
				agent: "codex",
				mode: "onRequest",
			});
			const server = servers[0] as FakeAppServer;
			socket.write(
				`${JSON.stringify({ type: "send", text: "hi", attachments: [] })}\n`,
			);
			await vi.waitFor(() => expect(server.requests("turn/start")).toHaveLength(1));
			server.push({
				method: "item/tool/requestUserInput",
				id: 50,
				params: {
					threadId: MAIN,
					turnId: "t",
					itemId: "q1",
					questions: [{ id: "k", header: "Pick", question: "Which?", options: null }],
				},
			});
			await vi.waitFor(() =>
				expect(frames.some((frame) => frame.type === "question.requested")).toBe(true),
			);
			socket.write(
				`${JSON.stringify({ type: "question.answer", id: "q1", answers: { "Which?": "This one" } })}\n`,
			);
			await vi.waitFor(() =>
				expect(server.reply(50)?.result).toEqual({
					answers: { k: { answers: ["This one"] } },
				}),
			);
			socket.destroy();
		} finally {
			await host.stop();
		}
	});
});
