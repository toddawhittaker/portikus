/**
 * The terminal question store and its two routes (SPEC.md §10.8, §24.1,
 * ADR 0075): a hook's question waits for the owner's answer from the API,
 * and anything else lets Claude Code ask in the terminal.
 */
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import {
	MAX_CODING_AGENT_TERMINALS,
	MAX_TERMINAL_QUESTION_POST_BYTES,
	type TerminalQuestion,
	type TerminalQuestionPost,
} from "@portikus/contracts";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AgentLimitsStore } from "./agent-limits-route.js";
import {
	AgentUsage,
	buildAgentUsageReceiver,
	CODING_AGENT_QUESTION_PATH,
} from "./agent-usage.js";
import { CodingAgentBoard } from "./coding-agent-status.js";
import {
	TERMINAL_QUESTION_WAIT_MS,
	TerminalQuestions,
	terminalQuestionRoute,
} from "./terminal-questions.js";

const TERMINAL = "4f7d2a8e-3b1c-4d5e-9f60-718293a4b5c6";
const OTHER = "0b9c8d7e-6f5a-4b3c-9d2e-1f0a9b8c7d6e";
const NOW = new Date("2026-11-11T12:00:00.000Z");

const INPUT = {
	questions: [
		{
			question: "Which database?",
			header: "Database",
			multiSelect: false,
			options: [
				{ label: "SQLite", description: "A file" },
				{ label: "Postgres", description: "A server" },
			],
		},
	],
};

function post(overrides: Partial<TerminalQuestionPost> = {}): TerminalQuestionPost {
	return {
		tool_name: "AskUserQuestion",
		tool_use_id: "toolu_01",
		tool_input: INPUT,
		...overrides,
	};
}

let shown: [string, TerminalQuestion | undefined][];
let store: TerminalQuestions;

beforeEach(() => {
	shown = [];
	store = new TerminalQuestions({
		onChange: (id, question) => shown.push([id, question]),
		now: () => NOW,
	});
});

afterEach(() => {
	vi.useRealTimers();
});

describe("the question store", () => {
	test("an answer becomes the hook's allow with the answers in the input", async () => {
		const waiting = store.ask(TERMINAL, post(), new AbortController().signal);
		expect(shown).toEqual([
			[
				TERMINAL,
				{
					id: "toolu_01",
					questions: INPUT.questions,
					expiresAt: new Date(NOW.getTime() + TERMINAL_QUESTION_WAIT_MS).toISOString(),
				},
			],
		]);
		expect(
			store.answer(TERMINAL, {
				id: "toolu_01",
				answers: { "Which database?": "Postgres" },
				notes: { "Which database?": "the one we use" },
			}),
		).toBe(true);
		await expect(waiting).resolves.toEqual({
			hookSpecificOutput: {
				hookEventName: "PreToolUse",
				permissionDecision: "allow",
				updatedInput: {
					...INPUT,
					answers: { "Which database?": "Postgres" },
					annotations: { "Which database?": { notes: "the one we use" } },
				},
			},
		});
		expect(shown.at(-1)).toEqual([TERMINAL, undefined]);
		// The question is gone, so a second answer is refused.
		expect(store.answer(TERMINAL, { id: "toolu_01", inTerminal: true })).toBe(false);
	});

	test("answer in the terminal lets Claude Code ask itself", async () => {
		const waiting = store.ask(TERMINAL, post(), new AbortController().signal);
		expect(store.answer(TERMINAL, { id: "toolu_01", inTerminal: true })).toBe(true);
		await expect(waiting).resolves.toBeNull();
		expect(shown.at(-1)).toEqual([TERMINAL, undefined]);
	});

	test("an answer for another call id or terminal is refused and the question waits", async () => {
		const waiting = store.ask(TERMINAL, post(), new AbortController().signal);
		expect(store.answer(TERMINAL, { id: "toolu_02", inTerminal: true })).toBe(false);
		expect(store.answer(OTHER, { id: "toolu_01", inTerminal: true })).toBe(false);
		expect(shown).toHaveLength(1);
		store.remove(TERMINAL);
		await expect(waiting).resolves.toBeNull();
	});

	test("a dropped hook connection clears the question", async () => {
		const hook = new AbortController();
		const waiting = store.ask(TERMINAL, post(), hook.signal);
		hook.abort();
		await expect(waiting).resolves.toBeNull();
		expect(shown.at(-1)).toEqual([TERMINAL, undefined]);
		expect(store.answer(TERMINAL, { id: "toolu_01", inTerminal: true })).toBe(false);
	});

	test("a terminal holds one question; a second asks in the terminal", async () => {
		const first = store.ask(TERMINAL, post(), new AbortController().signal);
		await expect(
			store.ask(
				TERMINAL,
				post({ tool_use_id: "toolu_02" }),
				new AbortController().signal,
			),
		).resolves.toBeNull();
		expect(shown).toHaveLength(1);
		// Another terminal is not held up by the first.
		const other = store.ask(OTHER, post(), new AbortController().signal);
		expect(shown).toHaveLength(2);
		store.remove(TERMINAL);
		store.remove(OTHER);
		await expect(Promise.all([first, other])).resolves.toEqual([null, null]);
	});

	test("too many waiting terminals ask in the terminal", async () => {
		const held = Array.from({ length: MAX_CODING_AGENT_TERMINALS }, (_, i) =>
			store.ask(`t-${i}`, post(), new AbortController().signal),
		);
		await expect(
			store.ask(TERMINAL, post(), new AbortController().signal),
		).resolves.toBeNull();
		for (let i = 0; i < held.length; i++) store.remove(`t-${i}`);
		await Promise.all(held);
	});

	test("the wait ends 10 seconds before the limit and Claude Code asks itself", async () => {
		vi.useFakeTimers();
		const waiting = store.ask(TERMINAL, post(), new AbortController().signal);
		vi.advanceTimersByTime(TERMINAL_QUESTION_WAIT_MS - 1);
		expect(shown).toHaveLength(1);
		vi.advanceTimersByTime(1);
		await expect(waiting).resolves.toBeNull();
		expect(shown.at(-1)).toEqual([TERMINAL, undefined]);
	});

	test.each([
		["another tool", post({ tool_name: "Bash", tool_input: { command: "rm -rf ~" } })],
		["another tool with question-shaped input", post({ tool_name: "Bash" })],
		["a name that only contains it", post({ tool_name: "mcp__x__AskUserQuestion" })],
		["questions that do not fit", post({ tool_input: { questions: [] } })],
		["input that is not an object", post({ tool_input: "Which database?" })],
	])("%s never waits or gets an allow", async (_, body) => {
		await expect(
			store.ask(TERMINAL, body, new AbortController().signal),
		).resolves.toBeNull();
		expect(shown).toEqual([]);
	});
});

describe("the board", () => {
	test("shows a terminal's waiting question on its entry until it goes", () => {
		const board = new CodingAgentBoard({ now: () => NOW });
		const question: TerminalQuestion = {
			id: "toolu_01",
			questions: INPUT.questions,
			expiresAt: NOW.toISOString(),
		};
		const frames: unknown[] = [];
		board.subscribe((terminals) => frames.push(terminals));
		// Before the state hook arrives there is no entry to show it on.
		board.question(TERMINAL, question);
		expect(frames).toEqual([]);
		board.set(TERMINAL, "claude", "needs-input", 1);
		expect(board.current()[0]?.question).toEqual(question);
		board.question(TERMINAL, undefined);
		expect(board.current()[0]).not.toHaveProperty("question");
		expect(frames).toHaveLength(2);
		board.remove(TERMINAL);
		board.question(TERMINAL, question);
		board.set(TERMINAL, "claude", "needs-input", 2);
		expect(board.current()).toEqual([]);
	});
});

describe("the loopback receiver", () => {
	function receiver() {
		return buildAgentUsageReceiver(new AgentUsage(), {
			board: new CodingAgentBoard(),
			limits: new AgentLimitsStore(),
			questions: store,
		});
	}

	test("waits for the answer and replies with the hook's output", async () => {
		const app = receiver();
		await app.listen({ host: "127.0.0.1", port: 0 });
		try {
			const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
			const response = fetch(
				`${url}${CODING_AGENT_QUESTION_PATH}?terminal=${TERMINAL}`,
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(post()),
				},
			);
			await vi.waitFor(() => expect(shown).toHaveLength(1));
			store.answer(TERMINAL, {
				id: "toolu_01",
				answers: { "Which database?": "SQLite" },
			});
			const answered = await response;
			expect(answered.status).toBe(200);
			expect(await answered.json()).toMatchObject({
				hookSpecificOutput: {
					permissionDecision: "allow",
					updatedInput: { answers: { "Which database?": "SQLite" } },
				},
			});
		} finally {
			await app.close();
		}
	});

	test("a hook that hangs up clears its question", async () => {
		const app = receiver();
		await app.listen({ host: "127.0.0.1", port: 0 });
		try {
			const port = (app.server.address() as AddressInfo).port;
			const body = JSON.stringify(post());
			const hook = httpRequest({
				host: "127.0.0.1",
				port,
				method: "POST",
				path: `${CODING_AGENT_QUESTION_PATH}?terminal=${TERMINAL}`,
				headers: { "content-type": "application/json", "content-length": body.length },
			});
			hook.on("error", () => {});
			hook.end(body);
			await vi.waitFor(() => expect(shown).toHaveLength(1));
			hook.destroy();
			await vi.waitFor(() => expect(shown.at(-1)).toEqual([TERMINAL, undefined]));
		} finally {
			await app.close();
		}
	});

	test("anything but a waiting AskUserQuestion gets a 204 at once", async () => {
		const app = receiver();
		const response = await app.inject({
			method: "POST",
			url: `${CODING_AGENT_QUESTION_PATH}?terminal=${TERMINAL}`,
			payload: post({ tool_name: "Bash" }),
		});
		expect(response.statusCode).toBe(204);
		expect(response.body).toBe("");
		await app.close();
	});

	test("refuses a body past the byte cap, a bad terminal, and extra fields", async () => {
		const app = receiver();
		const big = post({
			tool_input: { ...INPUT, padding: "x".repeat(MAX_TERMINAL_QUESTION_POST_BYTES) },
		});
		const cases = [
			[`?terminal=${TERMINAL}`, big, 413],
			["?terminal=not-a-terminal", post(), 400],
			["", post(), 400],
			[`?terminal=${TERMINAL}&extra=1`, post(), 400],
			[`?terminal=${TERMINAL}`, { ...post(), prompt: "secret" }, 400],
		] as const;
		for (const [query, payload, status] of cases) {
			const response = await app.inject({
				method: "POST",
				url: `${CODING_AGENT_QUESTION_PATH}${query}`,
				payload,
			});
			expect(response.statusCode).toBe(status);
		}
		expect(shown).toEqual([]);
		await app.close();
	});

	test("never takes an answer", async () => {
		const app = receiver();
		const waiting = store.ask(TERMINAL, post(), new AbortController().signal);
		const response = await app.inject({
			method: "POST",
			url: `/terminals/${TERMINAL}/question`,
			payload: { id: "toolu_01", answers: { "Which database?": "SQLite" } },
		});
		expect(response.statusCode).toBe(404);
		expect(shown).toHaveLength(1);
		store.remove(TERMINAL);
		await waiting;
		await app.close();
	});
});

describe("the answer route", () => {
	async function route() {
		const app = Fastify();
		await app.register(terminalQuestionRoute, { questions: store });
		return app;
	}

	test("an answer for the waiting question settles it", async () => {
		const app = await route();
		const waiting = store.ask(TERMINAL, post(), new AbortController().signal);
		const response = await app.inject({
			method: "POST",
			url: `/terminals/${TERMINAL}/question`,
			payload: { id: "toolu_01", inTerminal: true },
		});
		expect(response.statusCode).toBe(204);
		await expect(waiting).resolves.toBeNull();
		await app.close();
	});

	test("an answer for a question that is gone is a 409", async () => {
		const app = await route();
		const response = await app.inject({
			method: "POST",
			url: `/terminals/${TERMINAL}/question`,
			payload: { id: "toolu_01", answers: { "Which database?": "SQLite" } },
		});
		expect(response.statusCode).toBe(409);
		expect(response.json()).toEqual({
			error: { code: "BUSY", message: "answered in the terminal or timed out" },
		});
		await app.close();
	});

	test("an answer that does not fit the contract is a 400", async () => {
		const app = await route();
		for (const [id, payload] of [
			[TERMINAL, { id: "toolu_01" }],
			[TERMINAL, { id: "toolu_01", inTerminal: true, answers: {} }],
			["not-a-terminal", { id: "toolu_01", inTerminal: true }],
		] as const) {
			const response = await app.inject({
				method: "POST",
				url: `/terminals/${id}/question`,
				payload,
			});
			expect(response.statusCode).toBe(400);
		}
		await app.close();
	});
});
