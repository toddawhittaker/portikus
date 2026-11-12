/**
 * The terminal question store and its two routes (SPEC.md §10.8, §24.1,
 * ADR 0075): a hook's question waits for the owner's answer from the API,
 * and anything else lets Claude Code ask in the terminal.
 */
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import {
	AgentCodingAgentsChanged,
	MAX_CODING_AGENT_TERMINALS,
	MAX_SUBAGENTS_PER_TERMINAL,
	MAX_TERMINAL_QUESTION_POST_BYTES,
	MAX_TERMINAL_QUESTION_STRING_CHARS,
	MAX_TERMINAL_QUESTIONS_HELD_BYTES,
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
let closed: Set<string>;
let store: TerminalQuestions;

beforeEach(() => {
	shown = [];
	closed = new Set();
	store = new TerminalQuestions({
		onChange: (id, question) => shown.push([id, question]),
		isOpen: async (id) => !closed.has(id),
	});
});

/** Wait until the store has shown `count` questions; ask() checks the terminal first. */
async function shownCount(count: number) {
	await vi.waitFor(() => expect(shown).toHaveLength(count));
}

afterEach(() => {
	vi.useRealTimers();
});

describe("the question store", () => {
	test("an answer becomes the hook's allow with the answers in the input", async () => {
		const waiting = store.ask(TERMINAL, post(), new AbortController().signal);
		await shownCount(1);
		expect(shown).toEqual([[TERMINAL, { id: "toolu_01", questions: INPUT.questions }]]);
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
		await shownCount(1);
		expect(store.answer(TERMINAL, { id: "toolu_01", inTerminal: true })).toBe(true);
		await expect(waiting).resolves.toBeNull();
		expect(shown.at(-1)).toEqual([TERMINAL, undefined]);
	});

	test("an answer for another call id or terminal is refused and the question waits", async () => {
		const waiting = store.ask(TERMINAL, post(), new AbortController().signal);
		await shownCount(1);
		expect(store.answer(TERMINAL, { id: "toolu_02", inTerminal: true })).toBe(false);
		expect(store.answer(OTHER, { id: "toolu_01", inTerminal: true })).toBe(false);
		expect(shown).toHaveLength(1);
		store.remove(TERMINAL);
		await expect(waiting).resolves.toBeNull();
	});

	test("a dropped hook connection clears the question", async () => {
		const hook = new AbortController();
		const waiting = store.ask(TERMINAL, post(), hook.signal);
		await shownCount(1);
		hook.abort();
		await expect(waiting).resolves.toBeNull();
		expect(shown.at(-1)).toEqual([TERMINAL, undefined]);
		expect(store.answer(TERMINAL, { id: "toolu_01", inTerminal: true })).toBe(false);
	});

	test("a terminal holds one question; a second asks in the terminal", async () => {
		const first = store.ask(TERMINAL, post(), new AbortController().signal);
		await shownCount(1);
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
		await shownCount(2);
		store.remove(TERMINAL);
		store.remove(OTHER);
		await expect(Promise.all([first, other])).resolves.toEqual([null, null]);
	});

	test("too many waiting terminals ask in the terminal", async () => {
		const held = Array.from({ length: MAX_CODING_AGENT_TERMINALS }, (_, i) =>
			store.ask(`t-${i}`, post(), new AbortController().signal),
		);
		await shownCount(MAX_CODING_AGENT_TERMINALS);
		await expect(
			store.ask(TERMINAL, post(), new AbortController().signal),
		).resolves.toBeNull();
		for (let i = 0; i < held.length; i++) store.remove(`t-${i}`);
		await Promise.all(held);
	});

	test("the wait ends 10 seconds before the limit and Claude Code asks itself", async () => {
		vi.useFakeTimers();
		const waiting = store.ask(TERMINAL, post(), new AbortController().signal);
		await vi.advanceTimersByTimeAsync(0);
		expect(shown).toHaveLength(1);
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
		[
			"a question past the string cap",
			post({
				tool_input: {
					questions: [
						{
							...INPUT.questions[0],
							question: "x".repeat(MAX_TERMINAL_QUESTION_STRING_CHARS + 1),
						},
					],
				},
			}),
		],
	])("%s never waits or gets an allow", async (_, body) => {
		await expect(
			store.ask(TERMINAL, body, new AbortController().signal),
		).resolves.toBeNull();
		expect(shown).toEqual([]);
	});

	test("a terminal that is not open asks in the terminal", async () => {
		closed.add(TERMINAL);
		await expect(
			store.ask(TERMINAL, post(), new AbortController().signal),
		).resolves.toBeNull();
		expect(shown).toEqual([]);
		// A failed check counts as not open.
		const failing = new TerminalQuestions({
			onChange: (id, question) => shown.push([id, question]),
			isOpen: () => Promise.reject(new Error("tmux failed")),
		});
		await expect(
			failing.ask(TERMINAL, post(), new AbortController().signal),
		).resolves.toBeNull();
		expect(shown).toEqual([]);
	});

	test("20 terminals of maximal questions keep the frame well under the API's 1 MiB", async () => {
		// The API's cap on an agent frame (apps/api preview registry).
		const API_FRAME_BYTES = 1024 * 1024;
		const board = new CodingAgentBoard({ now: () => NOW });
		const held = new TerminalQuestions({
			onChange: (id, question) => board.question(id, question),
			isOpen: async () => true,
		});
		// Control characters take six bytes each in JSON, the most a character can.
		const text = (length: number) => "\u0001".repeat(length);
		// Every string the same length, the longest that keeps the post under its cap.
		const maximal = (n: number): TerminalQuestionPost => {
			const build = (length: number) => {
				const option = (label: string) => ({
					label: `${label}${text(length)}`,
					description: text(length),
					preview: text(length),
				});
				const one = (i: number) => ({
					question: `${i}${text(length)}`,
					header: "h".repeat(40),
					multiSelect: true,
					options: [option("a"), option("b"), option("c"), option("d")],
				});
				return post({
					tool_use_id: `toolu_${n}`,
					tool_input: { questions: [one(0), one(1), one(2), one(3)] },
				});
			};
			let [low, high] = [0, MAX_TERMINAL_QUESTION_STRING_CHARS - 1];
			while (low < high) {
				const mid = Math.ceil((low + high) / 2);
				if (JSON.stringify(build(mid)).length > MAX_TERMINAL_QUESTION_POST_BYTES)
					high = mid - 1;
				else low = mid;
			}
			const body = build(low);
			expect(JSON.stringify(body).length).toBeGreaterThan(
				MAX_TERMINAL_QUESTION_POST_BYTES - 1024,
			);
			return body;
		};
		const terminals = Array.from(
			{ length: MAX_CODING_AGENT_TERMINALS },
			(_, i) => `${i.toString(16).padStart(8, "0")}-3b1c-4d5e-9f60-718293a4b5c6`,
		);
		for (const [i, id] of terminals.entries()) {
			board.set(id, "claude", "needs-input", i + 1);
			for (let s = 0; s < MAX_SUBAGENTS_PER_TERMINAL; s++) {
				board.subagent({
					terminal: id,
					event: "pre_tool_use",
					at: i * 100 + s + 1,
					tool_use_id: `toolu_sub_${s}`,
					description: "d".repeat(120),
					subagent_type: "t".repeat(64),
				});
			}
		}
		const waits = terminals.map((id, i) =>
			held.ask(id, maximal(i), new AbortController().signal),
		);
		// Some are refused at once and ask in the terminal; the rest wait.
		await vi.waitFor(() =>
			expect(board.current().filter((one) => one.question).length).toBeGreaterThan(0),
		);
		const frame = JSON.stringify(
			AgentCodingAgentsChanged.parse({
				type: "workspace.coding-agents.changed",
				terminals: board.current(),
			}),
		);
		const questionBytes = board
			.current()
			.reduce(
				(sum, one) => sum + (one.question ? JSON.stringify(one.question).length : 0),
				0,
			);
		expect(questionBytes).toBeLessThanOrEqual(MAX_TERMINAL_QUESTIONS_HELD_BYTES);
		expect(Buffer.byteLength(frame)).toBeLessThan(API_FRAME_BYTES * 0.75);
		for (const id of terminals) held.remove(id);
		await Promise.all(waits);
	});

	test("ordinary questions on all 20 terminals are all held", async () => {
		const waits = Array.from({ length: MAX_CODING_AGENT_TERMINALS }, (_, i) =>
			store.ask(`t-${i}`, post(), new AbortController().signal),
		);
		await shownCount(MAX_CODING_AGENT_TERMINALS);
		for (let i = 0; i < MAX_CODING_AGENT_TERMINALS; i++) store.remove(`t-${i}`);
		await expect(Promise.all(waits)).resolves.toEqual(
			Array(MAX_CODING_AGENT_TERMINALS).fill(null),
		);
	});

	test("a question's bytes are given back when it goes", async () => {
		const big = (n: number) =>
			post({
				tool_use_id: `toolu_${n}`,
				tool_input: {
					questions: [
						{
							...INPUT.questions[0],
							question: String(n).padEnd(MAX_TERMINAL_QUESTION_STRING_CHARS, "x"),
							options: INPUT.questions[0].options.map((o) => ({
								label: o.label.padEnd(MAX_TERMINAL_QUESTION_STRING_CHARS, "x"),
								description: "x".repeat(MAX_TERMINAL_QUESTION_STRING_CHARS),
								preview: "x".repeat(MAX_TERMINAL_QUESTION_STRING_CHARS),
							})),
						},
					],
				},
			});
		const each = JSON.stringify({
			id: "toolu_0",
			questions: (big(0).tool_input as typeof INPUT).questions,
		}).length;
		const fit = Math.floor(MAX_TERMINAL_QUESTIONS_HELD_BYTES / each);
		// The byte cap, not the terminal cap, is what refuses here.
		expect(fit).toBeLessThan(MAX_CODING_AGENT_TERMINALS);
		const waits = Array.from({ length: fit }, (_, i) =>
			store.ask(`t-${i}`, big(i), new AbortController().signal),
		);
		await shownCount(fit);
		await expect(
			store.ask(TERMINAL, big(99), new AbortController().signal),
		).resolves.toBeNull();
		store.remove("t-0");
		await waits[0];
		const after = store.ask(TERMINAL, big(99), new AbortController().signal);
		await vi.waitFor(() => expect(shown.at(-1)?.[0]).toBe(TERMINAL));
		store.remove(TERMINAL);
		for (let i = 1; i < fit; i++) store.remove(`t-${i}`);
		await Promise.all([after, ...waits]);
	});
});

describe("the board", () => {
	test("shows a terminal's waiting question on its entry until it goes", () => {
		const board = new CodingAgentBoard({ now: () => NOW });
		const question: TerminalQuestion = {
			id: "toolu_01",
			questions: INPUT.questions,
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
		// A made-up terminal id is not an open terminal.
		closed.add(OTHER);
		const unknown = await app.inject({
			method: "POST",
			url: `${CODING_AGENT_QUESTION_PATH}?terminal=${OTHER}`,
			payload: post(),
		});
		expect(unknown.statusCode).toBe(204);
		expect(shown).toEqual([]);
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
		await shownCount(1);
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
		await shownCount(1);
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
