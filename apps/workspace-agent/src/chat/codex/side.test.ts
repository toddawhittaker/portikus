import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatSubagentEvent } from "@portikus/contracts";
import { collectingLogger } from "@portikus/observability/testing";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ChatEventBody, ContextFigures } from "../agent.js";
import {
	FakeAppServer,
	forkHandler,
	Refuse,
	recordedResult,
	segment,
} from "./fake-app-server.js";
import { CodexAgent, type PostedState } from "./host.js";
import { SIDE_BOUNDARY, sideItems } from "./side.js";

/** The recorded first thread of every fixture, which the stand-in starts. */
const MAIN = "00000000-0000-7000-8000-000000000002";
const FORK = "00000000-0000-7000-8000-0000000000f1";
const FORK2 = "00000000-0000-7000-8000-0000000000f2";
const SIDE_TURN = "00000000-0000-7000-8000-0000000000a1";

type Handlers = ConstructorParameters<typeof FakeAppServer>[0];

let home: string | null = null;

afterEach(async () => {
	vi.unstubAllEnvs();
	if (home) await rm(home, { recursive: true, force: true, maxRetries: 5 });
	home = null;
});

async function setup(handlers: Partial<Handlers> = {}) {
	vi.stubEnv("CODEX_HOME", "");
	home = await mkdtemp(join(tmpdir(), "portikus-codex-side-"));
	const projectDir = join(home, "projects", "demo");
	await mkdir(projectDir, { recursive: true });
	const all = {
		initialize: () => recordedResult("model-list", "initialize"),
		"thread/start": () => ({
			thread: { id: MAIN, name: null },
			model: "gpt-6.1-sol",
			reasoningEffort: "high",
		}),
		"model/list": () => recordedResult("model-list", "model/list"),
		"skills/list": () => ({ data: [] }),
		"mcpServerStatus/list": () => ({ data: [] }),
		"account/read": () => ({ account: null, requiresOpenaiAuth: true }),
		"thread/fork": forkHandler([FORK, FORK2]),
		"thread/inject_items": () => ({}),
		"turn/start": () => ({ turn: { id: SIDE_TURN } }),
		"turn/interrupt": () => ({}),
		"thread/unsubscribe": () => ({ status: "unsubscribed" }),
		...handlers,
	} as Handlers;
	const servers: FakeAppServer[] = [];
	const states: PostedState[] = [];
	const { logger, lines } = collectingLogger();
	const terminalId = randomUUID();
	const agent = new CodexAgent({
		terminalId,
		projectDir,
		homeDir: home,
		socketDir: home,
		log: logger,
		postTitle: async () => undefined,
		postState: async (state) => {
			states.push(state);
		},
		spawn: () => {
			const server = new FakeAppServer(all);
			servers.push(server);
			return server;
		},
	});
	const events: ChatEventBody[] = [];
	const contexts: ContextFigures[] = [];
	const cards: string[] = [];
	await agent.start({
		emit: (event) => events.push(event),
		models: () => undefined,
		settings: () => undefined,
		commands: () => undefined,
		context: (figures) => contexts.push(figures),
		rules: () => undefined,
		modes: () => undefined,
		mcp: () => undefined,
		signIn: () => undefined,
		openCard: (card) => cards.push(card.id),
		compacted: () => undefined,
		conversationReset: () => undefined,
	});
	const server = servers.at(-1) as FakeAppServer;
	const side: ChatSubagentEvent[] = [];
	const ask = (
		text: string,
		earlier: { question: string; answer: string }[] = [],
		signal = new AbortController().signal,
	) => agent.askSide(text, earlier, (event) => side.push(event), signal);
	return {
		agent,
		server,
		events,
		contexts,
		cards,
		states,
		lines,
		side,
		ask,
		terminalId,
	};
}

/** A recorded turn replayed on a side fork. */
function forkTurn(name: string, fork: string): Record<string, unknown>[] {
	return segment(name, "turn/start", 0, { from: MAIN, to: fork });
}

async function untilSent(server: FakeAppServer, method: string, count = 1) {
	await vi.waitFor(() => expect(server.requests(method).length).toBe(count));
}

describe("a Codex side question", () => {
	test("forks the main thread ephemeral and read-only, injects the boundary, then asks", async () => {
		const { server, ask } = await setup();
		const asked = ask("What file were we in?");
		await untilSent(server, "turn/start");
		const [fork] = server.requests("thread/fork");
		expect(fork?.params).toEqual({
			threadId: MAIN,
			ephemeral: true,
			excludeTurns: true,
			cwd: expect.any(String),
			sandbox: "read-only",
			approvalPolicy: "never",
			model: "gpt-6.1-sol",
		});
		expect(fork?.params).not.toHaveProperty("developerInstructions");
		const [inject] = server.requests("thread/inject_items");
		expect(inject?.params).toEqual({ threadId: FORK, items: sideItems([]) });
		expect(JSON.stringify(inject?.params)).toContain(SIDE_BOUNDARY);
		const [turn] = server.requests("turn/start");
		expect(turn?.params).toEqual({
			threadId: FORK,
			input: [{ type: "text", text: "What file were we in?", text_elements: [] }],
			approvalPolicy: "never",
			sandboxPolicy: { type: "readOnly", networkAccess: false },
			model: "gpt-6.1-sol",
			effort: "high",
		});
		// Inject comes before the turn.
		const order = server.sent
			.filter((message) => message.id !== undefined && message.method)
			.map((message) => message.method);
		expect(order.indexOf("thread/inject_items")).toBeLessThan(
			order.indexOf("turn/start"),
		);
		for (const message of forkTurn("token-usage", FORK)) server.push(message);
		await asked;
	});

	test("forks again for each question with the earlier exchanges injected", async () => {
		const { server, ask } = await setup();
		const first = ask("one");
		await untilSent(server, "turn/start");
		for (const message of forkTurn("token-usage", FORK)) server.push(message);
		await first;
		const earlier = [{ question: "one", answer: "first answer" }];
		const second = ask("two", earlier);
		await untilSent(server, "turn/start", 2);
		expect(server.requests("thread/fork").map((each) => each.params?.threadId)).toEqual(
			[MAIN, MAIN],
		);
		const items = server.requests("thread/inject_items")[1]?.params;
		expect(items).toEqual({ threadId: FORK2, items: sideItems(earlier) });
		expect(JSON.stringify(items)).toContain("first answer");
		expect(server.requests("thread/unsubscribe")[0]?.params).toEqual({
			threadId: FORK,
		});
		for (const message of forkTurn("token-usage", FORK2)) server.push(message);
		await second;
	});

	test("shows the fork's answer and read-only command rows, framed as side events", async () => {
		const { server, ask, side, terminalId } = await setup();
		const asked = ask("Read a.txt");
		await untilSent(server, "turn/start");
		for (const message of forkTurn("command-kinds", FORK)) server.push(message);
		await asked;
		for (const event of side)
			expect(ChatSubagentEvent.safeParse(event).success).toBe(true);
		expect(side.map((event) => event.seq)).toEqual(side.map((_, index) => index));
		expect(side.every((event) => event.sessionId === terminalId)).toBe(true);
		const kinds = side.map((event) => event.type);
		expect(kinds[0]).toBe("turn.started");
		expect(kinds).toContain("tool.started");
		expect(kinds.at(-1)).toBe("turn.finished");
		expect(side.at(-1)).toMatchObject({ status: "done" });
	});

	test("leaves the main transcript, the tab's state and the context meter alone", async () => {
		const { server, ask, events, contexts, states } = await setup();
		const eventsBefore = events.length;
		const contextsBefore = contexts.length;
		const asked = ask("How big is the context?");
		await untilSent(server, "turn/start");
		const turn = forkTurn("token-usage", FORK);
		expect(turn.some((message) => message.method === "thread/tokenUsage/updated")).toBe(
			true,
		);
		for (const message of turn) server.push(message);
		await asked;
		expect(events.length).toBe(eventsBefore);
		expect(contexts.length).toBe(contextsBefore);
		expect(states).toEqual([]);
	});

	test("refuses any request from a side thread without opening a card", async () => {
		const { server, ask, cards, states } = await setup();
		const asked = ask("Run something");
		await untilSent(server, "turn/start");
		const approvals = segment("command-approval", "turn/start", 0, {
			from: MAIN,
			to: FORK,
		}).filter((message) => message.id !== undefined);
		expect(approvals.length).toBeGreaterThan(0);
		for (const request of approvals) server.push(request);
		server.push({
			id: "question-1",
			method: "item/tool/requestUserInput",
			params: { threadId: FORK, turnId: SIDE_TURN, itemId: "q", questions: [] },
		});
		await vi.waitFor(() => expect(server.reply("question-1")).toBeDefined());
		for (const request of approvals) {
			expect(server.reply(request.id as string)?.error).toMatchObject({
				message: "A side conversation is read-only.",
			});
		}
		expect(server.reply("question-1")?.error).toBeDefined();
		expect(cards).toEqual([]);
		expect(states).toEqual([]);
		for (const message of forkTurn("token-usage", FORK)) server.push(message);
		await asked;
	});

	test("a stop interrupts the fork's turn and ends the question", async () => {
		const { server, ask, side } = await setup();
		const stop = new AbortController();
		const asked = ask("Long one", [], stop.signal);
		await untilSent(server, "turn/start");
		stop.abort();
		await asked;
		await untilSent(server, "turn/interrupt");
		expect(server.requests("turn/interrupt")[0]?.params).toEqual({
			threadId: FORK,
			turnId: SIDE_TURN,
		});
		expect(side.at(-1)).toMatchObject({ type: "turn.finished", status: "interrupted" });
		// A late event of the stopped fork shows nowhere.
		const count = side.length;
		for (const message of forkTurn("token-usage", FORK)) server.push(message);
		await untilSent(server, "thread/unsubscribe");
		expect(side.length).toBe(count);
	});

	test("a stop before the fork answers drops the fork once it exists", async () => {
		const { server, ask } = await setup();
		const stop = new AbortController();
		server.handlers["thread/fork"] = () => {
			stop.abort();
			return forkHandler([FORK])({});
		};
		await ask("Quick", [], stop.signal);
		await untilSent(server, "thread/unsubscribe");
		expect(server.requests("turn/start")).toEqual([]);
	});

	test("endSide interrupts a running question and unsubscribes its fork", async () => {
		const { agent, server, ask, side } = await setup();
		const asked = ask("Anything");
		await untilSent(server, "turn/start");
		await agent.endSide();
		await asked;
		expect(server.requests("turn/interrupt")[0]?.params).toEqual({
			threadId: FORK,
			turnId: SIDE_TURN,
		});
		await untilSent(server, "thread/unsubscribe");
		expect(side.at(-1)).toMatchObject({ status: "interrupted" });
		// Ending with nothing running does nothing.
		await agent.endSide();
	});

	test("one question at a time", async () => {
		const { server, ask } = await setup();
		const first = ask("one");
		await expect(ask("two")).rejects.toThrow(/Wait for the side answer/);
		await untilSent(server, "turn/start");
		for (const message of forkTurn("token-usage", FORK)) server.push(message);
		await first;
	});

	test("a failed turn rejects with Codex's message", async () => {
		const { server, ask, side } = await setup();
		const asked = ask("Break");
		await untilSent(server, "turn/start");
		server.push({
			method: "error",
			params: { threadId: FORK, willRetry: false, error: { message: "Over quota" } },
		});
		server.push({
			method: "turn/completed",
			params: { threadId: FORK, turn: { id: SIDE_TURN, status: "failed" } },
		});
		await expect(asked).rejects.toThrow("Over quota");
		expect(side.at(-1)).toMatchObject({ status: "error" });
	});

	test("a refused fork rejects", async () => {
		const { ask } = await setup({ "thread/fork": () => new Refuse("no fork") });
		await expect(ask("Hi")).rejects.toThrow("no fork");
	});

	test("Codex stopping ends the running question", async () => {
		const { server, ask } = await setup();
		const asked = ask("Hi");
		await untilSent(server, "turn/start");
		server.exit();
		await expect(asked).rejects.toThrow(/Codex stopped/);
	});

	test("logs nothing from the side conversation", async () => {
		const { server, ask, lines } = await setup();
		const before = lines.length;
		const asked = ask("secret side question");
		await untilSent(server, "turn/start");
		for (const message of forkTurn("command-kinds", FORK)) server.push(message);
		await asked;
		expect(lines.slice(before)).toEqual([]);
		expect(JSON.stringify(lines)).not.toContain("secret side question");
	});
});
