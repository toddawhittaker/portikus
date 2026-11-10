/**
 * The coding-agent state board and the receiver routes that feed it and the
 * plan limits store (SPEC.md §10.8, ADR 0057): contract-shaped input only,
 * bounded in size and count.
 */
import { MAX_CODING_AGENT_TERMINALS } from "@portikus/contracts";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AgentLimitsStore } from "./agent-limits-route.js";
import {
	AgentUsage,
	buildAgentUsageReceiver,
	CLAUDE_LIMITS_PATH,
	CODING_AGENT_STATE_PATH,
	MAX_SIGNAL_BODY_BYTES,
} from "./agent-usage.js";
import { CodingAgentBoard } from "./coding-agent-status.js";

const NOW = new Date("2027-01-15T07:00:00.000Z");
const ID = "4f7d2a8e-3b1c-4d5e-9f60-718293a4b5c6";
/** NOW in microseconds, as the hook script sends it. */
const AT = NOW.getTime() * 1000;

function terminalId(n: number): string {
	return `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;
}

describe("CodingAgentBoard", () => {
	test("keeps the latest state per terminal and tells subscribers", () => {
		let now = NOW;
		const board = new CodingAgentBoard({ now: () => now });
		const seen = vi.fn();
		board.subscribe(seen);
		board.set(ID, "claude", "working", 1);
		now = new Date(NOW.getTime() + 1000);
		board.set(ID, "claude", "needs-input", 2);
		expect(board.current()).toEqual([
			{
				terminalId: ID,
				agent: "claude",
				state: "needs-input",
				since: now.toISOString(),
				subagents: [],
			},
		]);
		expect(seen).toHaveBeenCalledTimes(2);
	});

	test("a repeated state keeps its time and is not announced", () => {
		let now = NOW;
		const board = new CodingAgentBoard({ now: () => now });
		board.set(ID, "codex", "working", 1);
		const seen = vi.fn();
		board.subscribe(seen);
		now = new Date(NOW.getTime() + 5000);
		board.set(ID, "codex", "working", 2);
		expect(seen).not.toHaveBeenCalled();
		expect(board.current()[0]?.since).toBe(NOW.toISOString());
	});

	test("remove forgets a terminal; removing an unknown one says nothing", () => {
		const board = new CodingAgentBoard();
		board.set(ID, "claude", "finished", 1);
		const seen = vi.fn();
		board.subscribe(seen);
		board.remove(terminalId(1));
		expect(seen).not.toHaveBeenCalled();
		board.remove(ID);
		expect(board.current()).toEqual([]);
		expect(seen).toHaveBeenCalledWith([]);
	});

	test("past the cap the oldest terminal goes", () => {
		const board = new CodingAgentBoard();
		for (let n = 0; n <= MAX_CODING_AGENT_TERMINALS; n++) {
			board.set(terminalId(n), "claude", "working", 1);
		}
		const ids = board.current().map((t) => t.terminalId);
		expect(ids).toHaveLength(MAX_CODING_AGENT_TERMINALS);
		expect(ids).not.toContain(terminalId(0));
		expect(ids).toContain(terminalId(MAX_CODING_AGENT_TERMINALS));
	});

	test("a late post older than the current state is ignored", () => {
		const board = new CodingAgentBoard();
		// Stop fired after PostToolUse, but its post arrived first.
		board.set(ID, "claude", "finished", 20);
		board.set(ID, "claude", "working", 10);
		expect(board.current()).toEqual([expect.objectContaining({ state: "finished" })]);
	});

	test("an old clear is ignored, and a clear keeps out older posts", () => {
		const board = new CodingAgentBoard();
		board.set(ID, "claude", "working", 20);
		board.clear(ID, 10);
		expect(board.current()).toEqual([expect.objectContaining({ state: "working" })]);
		board.clear(ID, 30);
		expect(board.current()).toEqual([]);
		board.set(ID, "claude", "finished", 25);
		expect(board.current()).toEqual([]);
		board.set(ID, "claude", "working", 40);
		expect(board.current()).toEqual([expect.objectContaining({ state: "working" })]);
	});

	test("a late post for a removed terminal does not bring it back", () => {
		const board = new CodingAgentBoard();
		const seen = vi.fn();
		board.set(ID, "claude", "working", 20);
		board.subscribe(seen);
		board.remove(ID);
		seen.mockClear();
		board.set(ID, "claude", "finished", 15);
		board.set(ID, "claude", "working", 20);
		board.clear(ID, 20);
		expect(board.current()).toEqual([]);
		expect(seen).not.toHaveBeenCalled();
	});

	test("a removed terminal's id refuses every later post, even a newer one", () => {
		const board = new CodingAgentBoard();
		board.set(ID, "claude", "working", 20);
		board.remove(ID);
		board.set(ID, "codex", "working", 21);
		expect(board.current()).toEqual([]);
	});

	test("a post that fired before the close but arrived after makes no ghost", () => {
		const board = new CodingAgentBoard();
		board.remove(ID);
		board.set(ID, "claude", "working", 5);
		expect(board.current()).toEqual([]);
	});

	test("removed terminals' times stay capped", () => {
		const board = new CodingAgentBoard();
		for (let n = 0; n < 100; n++) {
			board.set(terminalId(n), "claude", "working", 10);
			board.remove(terminalId(n));
		}
		// The newest removals are still remembered; the oldest have aged out.
		board.set(terminalId(99), "claude", "working", 10);
		expect(board.current()).toEqual([]);
		board.set(terminalId(0), "claude", "working", 10);
		expect(board.current()).toHaveLength(1);
	});

	test("an unsubscribed listener hears nothing more", () => {
		const board = new CodingAgentBoard();
		const seen = vi.fn();
		board.subscribe(seen)();
		board.set(ID, "claude", "working", 1);
		expect(seen).not.toHaveBeenCalled();
	});
});

function receiver() {
	const board = new CodingAgentBoard({ now: () => NOW });
	const limits = new AgentLimitsStore();
	const app = buildAgentUsageReceiver(new AgentUsage(), {
		board,
		limits,
		now: () => NOW,
	});
	const post = (url: string, payload: unknown) =>
		app.inject({
			method: "POST",
			url,
			headers: { "content-type": "application/json" },
			payload: typeof payload === "string" ? payload : JSON.stringify(payload),
		});
	return { board, limits, post };
}

describe("the state route", () => {
	test("a valid post sets the state, and clear removes it", async () => {
		const { board, post } = receiver();
		const set = await post(CODING_AGENT_STATE_PATH, {
			terminal: ID,
			agent: "codex",
			state: "working",
			at: AT,
		});
		expect(set.statusCode).toBe(204);
		expect(board.current()).toEqual([
			{
				terminalId: ID,
				agent: "codex",
				state: "working",
				since: NOW.toISOString(),
				subagents: [],
			},
		]);
		const clear = await post(CODING_AGENT_STATE_PATH, {
			terminal: ID,
			agent: "codex",
			state: "clear",
			at: AT + 1000,
		});
		expect(clear.statusCode).toBe(204);
		expect(board.current()).toEqual([]);
	});

	test.each([
		[
			"a terminal that is not a uuid",
			{ terminal: `pk-${ID}`, agent: "claude", state: "working", at: AT },
		],
		["an unknown agent", { terminal: ID, agent: "gemini", state: "working", at: AT }],
		["an unknown state", { terminal: ID, agent: "claude", state: "thinking", at: AT }],
		[
			"an extra field",
			{ terminal: ID, agent: "claude", state: "working", at: AT, prompt: "x" },
		],
		["no time", { terminal: ID, agent: "claude", state: "working" }],
		[
			"a time that is not an integer",
			{ terminal: ID, agent: "claude", state: "working", at: "1" },
		],
		[
			"a time over a minute ahead",
			{ terminal: ID, agent: "claude", state: "working", at: AT + 61_000 * 1000 },
		],
		["no body fields", {}],
	])("%s is refused", async (_name, body) => {
		const { board, post } = receiver();
		const response = await post(CODING_AGENT_STATE_PATH, body);
		expect(response.statusCode).toBe(400);
		expect(board.current()).toEqual([]);
	});

	test("an oversized body is refused", async () => {
		const { board, post } = receiver();
		const response = await post(
			CODING_AGENT_STATE_PATH,
			JSON.stringify({ terminal: ID, agent: "claude", state: "working", at: AT }) +
				" ".repeat(MAX_SIGNAL_BODY_BYTES),
		);
		expect(response.statusCode).toBe(413);
		expect(board.current()).toEqual([]);
	});
});

describe("the Claude limits route", () => {
	// The contract bounds a reset by the real clock.
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(NOW);
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	const FIVE_HOUR_RESET = Math.floor(NOW.getTime() / 1000) + 3600;
	const WEEK_RESET = Math.floor(NOW.getTime() / 1000) + 3 * 86_400;

	test("a valid post becomes Claude's limits, in the contract's shape", async () => {
		const { limits, post } = receiver();
		const response = await post(CLAUDE_LIMITS_PATH, {
			five_hour: { used_percentage: 42.5, resets_at: FIVE_HOUR_RESET },
			seven_day: { used_percentage: 18, resets_at: WEEK_RESET },
		});
		expect(response.statusCode).toBe(204);
		expect(await limits.report()).toEqual({
			claude: {
				windows: [
					{
						name: "5h",
						usedPercent: 42.5,
						resetsAt: "2027-01-15T08:00:00.000Z",
					},
					{
						name: "7d",
						usedPercent: 18,
						resetsAt: "2027-01-18T07:00:00.000Z",
					},
				],
				observedAt: NOW.toISOString(),
			},
			codex: null,
		});
	});

	test("one window alone is taken", async () => {
		const { limits, post } = receiver();
		await post(CLAUDE_LIMITS_PATH, {
			seven_day: { used_percentage: 5, resets_at: WEEK_RESET },
		});
		expect((await limits.report()).claude?.windows.map((w) => w.name)).toEqual(["7d"]);
	});

	test.each([
		[
			"a percentage over 100",
			{ five_hour: { used_percentage: 101, resets_at: FIVE_HOUR_RESET } },
		],
		["a reset as a string", { five_hour: { used_percentage: 1, resets_at: "soon" } }],
		[
			"a reset far in the future",
			{ five_hour: { used_percentage: 1, resets_at: 9_999_999_999 } },
		],
		["an unknown window", { opus_week: { used_percentage: 1, resets_at: WEEK_RESET } }],
		[
			"an extra field",
			{ five_hour: { used_percentage: 1, resets_at: FIVE_HOUR_RESET, cwd: "/x" } },
		],
	])("%s is refused", async (_name, body) => {
		const { limits, post } = receiver();
		const response = await post(CLAUDE_LIMITS_PATH, body);
		expect(response.statusCode).toBe(400);
		expect((await limits.report()).claude).toBeNull();
	});

	test("an oversized body is refused", async () => {
		const { post } = receiver();
		const response = await post(
			CLAUDE_LIMITS_PATH,
			`{}${" ".repeat(MAX_SIGNAL_BODY_BYTES)}`,
		);
		expect(response.statusCode).toBe(413);
	});
});
