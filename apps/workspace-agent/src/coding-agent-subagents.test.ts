/**
 * Subagent rows on the coding-agent board and the receiver route that feeds
 * them (SPEC.md §10.8, ADR 0070): keyed by Agent tool call id, ordered per
 * row, at most sixteen per terminal.
 */
import {
	type CodingAgentSubagentPost,
	MAX_SUBAGENT_DESCRIPTION_CHARS,
	MAX_SUBAGENTS_PER_TERMINAL,
} from "@portikus/contracts";
import { describe, expect, test, vi } from "vitest";
import { AgentLimitsStore } from "./agent-limits-route.js";
import {
	AgentUsage,
	buildAgentUsageReceiver,
	CODING_AGENT_SUBAGENT_PATH,
} from "./agent-usage.js";
import { CodingAgentBoard } from "./coding-agent-status.js";

const NOW = new Date("2027-01-15T07:00:00.000Z");
const ID = "4f7d2a8e-3b1c-4d5e-9f60-718293a4b5c6";
const OTHER = "00000000-0000-4000-8000-000000000002";

type Event = CodingAgentSubagentPost["event"];

function post(
	event: Event,
	at: number,
	fields: Partial<CodingAgentSubagentPost> = {},
): CodingAgentSubagentPost {
	return { terminal: ID, event, at, ...fields };
}

function start(
	id: string,
	at: number,
	fields: Partial<CodingAgentSubagentPost> = {},
): CodingAgentSubagentPost {
	return post("pre_tool_use", at, {
		tool_use_id: id,
		description: `Task ${id}`,
		subagent_type: "Explore",
		...fields,
	});
}

function board(): CodingAgentBoard {
	const b = new CodingAgentBoard({ now: () => NOW });
	b.set(ID, "claude", "working", 1);
	return b;
}

function rows(b: CodingAgentBoard, terminal = ID) {
	return b.current().find((t) => t.terminalId === terminal)?.subagents ?? [];
}

function states(b: CodingAgentBoard): string[] {
	return rows(b).map((row) => `${row.id}:${row.state}`);
}

describe("subagent rows", () => {
	test("a foreground call shows working, then finished at its PostToolUse", () => {
		const b = board();
		const seen = vi.fn();
		b.subscribe(seen);
		b.subagent(start("toolu_a", 10));
		expect(rows(b)).toEqual([
			{
				id: "toolu_a",
				type: "Explore",
				description: "Task toolu_a",
				state: "working",
				since: NOW.toISOString(),
			},
		]);
		b.subagent(post("post_tool_use", 20, { tool_use_id: "toolu_a", agent_id: "ag1" }));
		expect(states(b)).toEqual(["toolu_a:finished"]);
		expect(seen).toHaveBeenCalledTimes(2);
	});

	test("a call naming no type gets Claude Code's default", () => {
		const b = board();
		b.subagent(post("pre_tool_use", 10, { tool_use_id: "toolu_a" }));
		expect(rows(b)[0]).toMatchObject({ type: "general-purpose", description: "" });
	});

	test("a background call stays working past its PostToolUse until its SubagentStop", () => {
		const b = board();
		b.subagent(start("toolu_b", 10, { run_in_background: true }));
		b.subagent(post("post_tool_use", 20, { tool_use_id: "toolu_b", agent_id: "ag1" }));
		expect(states(b)).toEqual(["toolu_b:working"]);
		b.subagent(post("stop", 25));
		expect(states(b)).toEqual(["toolu_b:working"]);
		b.subagent(post("subagent_stop", 30, { agent_id: "other" }));
		expect(states(b)).toEqual(["toolu_b:working"]);
		b.subagent(post("subagent_stop", 40, { agent_id: "ag1" }));
		expect(states(b)).toEqual(["toolu_b:finished"]);
	});

	test("a SubagentStop that arrives before the post naming its agent still finishes the row", () => {
		const b = board();
		b.subagent(start("toolu_b", 10, { run_in_background: true }));
		b.subagent(post("subagent_stop", 40, { agent_id: "ag1" }));
		expect(states(b)).toEqual(["toolu_b:working"]);
		b.subagent(post("post_tool_use", 20, { tool_use_id: "toolu_b", agent_id: "ag1" }));
		expect(states(b)).toEqual(["toolu_b:finished"]);
	});

	test("a SubagentStop with no start adds no row", () => {
		const b = board();
		b.subagent(post("subagent_stop", 10, { agent_id: "ag1" }));
		expect(rows(b)).toEqual([]);
	});

	test("a failed call removes its row, and a late start cannot bring it back", () => {
		const b = board();
		b.subagent(start("toolu_a", 10));
		b.subagent(post("post_tool_use_failure", 20, { tool_use_id: "toolu_a" }));
		expect(rows(b)).toEqual([]);
		b.subagent(start("toolu_a", 10));
		expect(rows(b)).toEqual([]);
	});

	test("a PostToolUse that overtakes its PreToolUse leaves no stuck row", () => {
		const b = board();
		b.subagent(post("post_tool_use", 20, { tool_use_id: "toolu_a" }));
		b.subagent(start("toolu_a", 10));
		expect(rows(b)).toEqual([]);
	});

	test("Stop finishes working foreground rows that started before it", () => {
		const b = board();
		b.subagent(start("toolu_a", 10));
		b.subagent(start("toolu_late", 30));
		b.subagent(post("stop", 20));
		expect(states(b)).toEqual(["toolu_a:finished", "toolu_late:working"]);
	});

	test("UserPromptSubmit drops finished rows and keeps working ones", () => {
		const b = board();
		b.subagent(start("toolu_a", 10));
		b.subagent(post("post_tool_use", 20, { tool_use_id: "toolu_a" }));
		b.subagent(start("toolu_b", 15, { run_in_background: true }));
		b.subagent(post("user_prompt_submit", 30));
		expect(states(b)).toEqual(["toolu_b:working"]);
	});

	test("posts are ordered per row, so one terminal's late state post loses none", () => {
		const b = board();
		b.set(ID, "claude", "needs-input", 100);
		// Older than the terminal's latest state post, and still kept.
		b.subagent(start("toolu_a", 50));
		expect(states(b)).toEqual(["toolu_a:working"]);
	});

	test("rows stay hidden until the terminal has a state, then appear", () => {
		const b = new CodingAgentBoard({ now: () => NOW });
		b.subagent(start("toolu_a", 10));
		expect(b.current()).toEqual([]);
		b.set(ID, "claude", "working", 5);
		expect(states(b)).toEqual(["toolu_a:working"]);
	});

	test("each terminal keeps its own rows", () => {
		const b = board();
		b.set(OTHER, "claude", "working", 1);
		b.subagent(start("toolu_a", 10));
		b.subagent({ ...start("toolu_b", 10), terminal: OTHER });
		expect(rows(b).map((r) => r.id)).toEqual(["toolu_a"]);
		expect(rows(b, OTHER).map((r) => r.id)).toEqual(["toolu_b"]);
	});

	test("at most sixteen rows per terminal, finished ones dropped first", () => {
		const b = board();
		for (let n = 0; n < MAX_SUBAGENTS_PER_TERMINAL; n++)
			b.subagent(start(`t${n}`, 10 + n));
		b.subagent(post("post_tool_use", 100, { tool_use_id: "t5" }));
		b.subagent(start("new1", 200));
		expect(rows(b)).toHaveLength(MAX_SUBAGENTS_PER_TERMINAL);
		expect(rows(b).map((r) => r.id)).not.toContain("t5");
		b.subagent(start("new2", 201));
		expect(rows(b)).toHaveLength(MAX_SUBAGENTS_PER_TERMINAL);
		expect(rows(b).map((r) => r.id)).not.toContain("t0");
		expect(rows(b).map((r) => r.id)).toContain("new2");
	});

	test("a removed terminal takes no more rows; a cleared one starts empty", () => {
		const b = board();
		b.subagent(start("toolu_a", 10));
		b.clear(ID, 20);
		b.set(ID, "claude", "working", 30);
		expect(rows(b)).toEqual([]);
		b.remove(ID);
		b.subagent(start("toolu_b", 40));
		expect(b.current()).toEqual([]);
	});
});

describe("POST /coding-agent-subagent", () => {
	function receiver() {
		const b = board();
		const app = buildAgentUsageReceiver(new AgentUsage(), {
			board: b,
			limits: new AgentLimitsStore(),
			now: () => NOW,
		});
		return { app, b };
	}
	const at = NOW.getTime() * 1000;

	test("a valid post adds a row and answers 204", async () => {
		const { app, b } = receiver();
		const response = await app.inject({
			method: "POST",
			url: CODING_AGENT_SUBAGENT_PATH,
			payload: {
				terminal: ID,
				event: "pre_tool_use",
				at,
				tool_use_id: "toolu_a",
				description: `  ${"d".repeat(MAX_SUBAGENT_DESCRIPTION_CHARS + 30)}`,
				subagent_type: "Explore",
				run_in_background: false,
			},
		});
		expect(response.statusCode).toBe(204);
		expect(rows(b)[0]?.description).toHaveLength(MAX_SUBAGENT_DESCRIPTION_CHARS);
	});

	test.each([
		["an unknown field, such as a prompt", { prompt: "secret" }],
		["an unknown event", { event: "session_start" }],
		["a bad tool call id", { tool_use_id: "a b" }],
		["a bad terminal", { terminal: "nope" }],
		["a time too far ahead", { at: at + 3_600_000_000 }],
	])("%s is refused with 400", async (_name, change) => {
		const { app, b } = receiver();
		const response = await app.inject({
			method: "POST",
			url: CODING_AGENT_SUBAGENT_PATH,
			payload: {
				terminal: ID,
				event: "pre_tool_use",
				at,
				tool_use_id: "toolu_a",
				...change,
			},
		});
		expect(response.statusCode).toBe(400);
		expect(rows(b)).toEqual([]);
	});

	test("a body over the signal limit is refused with 413", async () => {
		const { app } = receiver();
		const response = await app.inject({
			method: "POST",
			url: CODING_AGENT_SUBAGENT_PATH,
			payload: { terminal: ID, event: "stop", at, pad: "x".repeat(8 * 1024) },
		});
		expect(response.statusCode).toBe(413);
	});
});
