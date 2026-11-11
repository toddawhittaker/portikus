import { describe, expect, test } from "vitest";
import {
	AgentCodingAgentStatus,
	AgentCodingAgentsChanged,
	AgentLimitsReport,
	AgentMeter,
	agentTitleText,
	ChatClientMessage,
	CodingAgentState,
	CodingAgentSubagent,
	CodingAgentSubagentPost,
	CodingAgentTerminal,
	CodingAgentTitlePost,
	MAX_CODING_AGENT_TERMINALS,
	MAX_SUBAGENTS_PER_TERMINAL,
	PlanUsage,
} from "./index.js";

const NOW = new Date().toISOString();
const DAY = 86_400_000;
const inDays = (days: number): string =>
	new Date(Date.now() + days * DAY).toISOString();

function status(index = 0) {
	return {
		terminalId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
		agent: "claude" as const,
		state: "working" as const,
		since: NOW,
	};
}

test("the three agent states are the only ones", () => {
	expect(CodingAgentState.options).toEqual(["working", "needs-input", "finished"]);
	expect(CodingAgentState.safeParse("idle").success).toBe(false);
});

test("a coding-agents frame holds at most twenty terminals", () => {
	const frame = (count: number) => ({
		type: "workspace.coding-agents.changed",
		terminals: Array.from({ length: count }, (_, i) => status(i)),
	});
	expect(MAX_CODING_AGENT_TERMINALS).toBe(20);
	expect(AgentCodingAgentsChanged.safeParse(frame(20)).success).toBe(true);
	expect(AgentCodingAgentsChanged.safeParse(frame(21)).success).toBe(false);
	expect(AgentCodingAgentsChanged.safeParse(frame(0)).success).toBe(true);
});

test("a terminal entry needs a known agent, a uuid and an ISO time", () => {
	const frame = (terminal: object) => ({
		type: "workspace.coding-agents.changed",
		terminals: [terminal],
	});
	expect(AgentCodingAgentsChanged.safeParse(frame(status())).success).toBe(true);
	expect(
		AgentCodingAgentsChanged.safeParse(frame({ ...status(), agent: "gemini" })).success,
	).toBe(false);
	expect(
		AgentCodingAgentsChanged.safeParse(frame({ ...status(), terminalId: "tty1" }))
			.success,
	).toBe(false);
	expect(
		AgentCodingAgentsChanged.safeParse(frame({ ...status(), since: "yesterday" }))
			.success,
	).toBe(false);
});

test("the browser terminal adds a project id", () => {
	const projectId = "11111111-1111-4111-8111-111111111111";
	const named = { ...status(), projectId, name: "Claude" };
	expect(CodingAgentTerminal.safeParse(named).success).toBe(true);
	expect(CodingAgentTerminal.safeParse({ ...status(), name: "Claude" }).success).toBe(
		false,
	);
});

test("the browser terminal carries the terminal's kind, a plain terminal when missing", () => {
	const projectId = "11111111-1111-4111-8111-111111111111";
	const base = { ...status(), projectId, name: "Terminal 2" };
	expect(CodingAgentTerminal.parse({ ...base, kind: "chat" }).kind).toBe("chat");
	expect(CodingAgentTerminal.parse(base).kind).toBe("terminal");
	expect(CodingAgentTerminal.safeParse({ ...base, kind: "notebook" }).success).toBe(
		false,
	);
});

test("the browser terminal needs a name of 1 to 64 characters", () => {
	const projectId = "11111111-1111-4111-8111-111111111111";
	const withName = (name: string) =>
		CodingAgentTerminal.safeParse({ ...status(), projectId, name }).success;
	expect(withName("")).toBe(false);
	expect(withName("x")).toBe(true);
	expect(withName("x".repeat(64))).toBe(true);
	expect(withName("x".repeat(65))).toBe(false);
});

function subagent(index = 0) {
	return {
		id: `toolu_${index}`,
		type: "Explore",
		description: "Find the login code",
		state: "working" as const,
		since: NOW,
	};
}

test("a subagent row has a safe id, a type, a short description and a state", () => {
	expect(CodingAgentSubagent.safeParse(subagent()).success).toBe(true);
	const ok = (change: object) =>
		CodingAgentSubagent.safeParse({ ...subagent(), ...change }).success;
	expect(ok({ id: "a".repeat(64) })).toBe(true);
	expect(ok({ id: "a".repeat(65) })).toBe(false);
	expect(ok({ id: "" })).toBe(false);
	expect(ok({ id: "has space" })).toBe(false);
	expect(ok({ id: "a/b" })).toBe(false);
	expect(ok({ type: "" })).toBe(false);
	expect(ok({ type: "t".repeat(64) })).toBe(true);
	expect(ok({ type: "t".repeat(65) })).toBe(false);
	expect(ok({ description: "" })).toBe(true);
	expect(ok({ description: "d".repeat(120) })).toBe(true);
	expect(ok({ description: "d".repeat(121) })).toBe(false);
	expect(ok({ state: "finished" })).toBe(true);
	expect(ok({ state: "needs-input" })).toBe(false);
	expect(ok({ since: "yesterday" })).toBe(false);
});

test("a terminal holds at most sixteen subagent rows", () => {
	const rows = (count: number) => Array.from({ length: count }, (_, i) => subagent(i));
	expect(MAX_SUBAGENTS_PER_TERMINAL).toBe(16);
	expect(
		AgentCodingAgentsChanged.safeParse({
			type: "workspace.coding-agents.changed",
			terminals: [{ ...status(), subagents: rows(16) }],
		}).success,
	).toBe(true);
	expect(
		AgentCodingAgentsChanged.safeParse({
			type: "workspace.coding-agents.changed",
			terminals: [{ ...status(), subagents: rows(17) }],
		}).success,
	).toBe(false);
});

test("a status from before subagents parses with an empty list", () => {
	const projectId = "11111111-1111-4111-8111-111111111111";
	const frame = AgentCodingAgentsChanged.parse({
		type: "workspace.coding-agents.changed",
		terminals: [status()],
	});
	expect(frame.terminals[0]?.subagents).toEqual([]);
	const terminal = CodingAgentTerminal.parse({ ...status(), projectId, name: "A" });
	expect(terminal.subagents).toEqual([]);
});

describe("the subagent hook post", () => {
	const terminal = "00000000-0000-4000-8000-000000000001";
	const post = (change: object = {}) => ({
		terminal,
		event: "pre_tool_use",
		at: 1_700_000_000_000_000,
		tool_use_id: "toolu_01",
		description: "Find the login code",
		subagent_type: "Explore",
		...change,
	});
	const ok = (change?: object) =>
		CodingAgentSubagentPost.safeParse(post(change)).success;

	test("takes each of the six events", () => {
		for (const event of [
			"pre_tool_use",
			"post_tool_use",
			"post_tool_use_failure",
			"subagent_stop",
			"user_prompt_submit",
			"stop",
		]) {
			expect(ok({ event })).toBe(true);
		}
		expect(ok({ event: "notification" })).toBe(false);
	});

	test("the optional fields may be left out or sent", () => {
		expect(
			CodingAgentSubagentPost.safeParse({
				terminal,
				event: "stop",
				at: 1,
			}).success,
		).toBe(true);
		expect(ok({ agent_id: "agent-1", run_in_background: true })).toBe(true);
		expect(ok({ run_in_background: "yes" })).toBe(false);
		expect(ok({ agent_id: "" })).toBe(false);
	});

	test("refuses a bad terminal, id, time, type or extra field", () => {
		expect(ok({ terminal: "tty1" })).toBe(false);
		expect(ok({ tool_use_id: "has space" })).toBe(false);
		expect(ok({ tool_use_id: "a".repeat(65) })).toBe(false);
		expect(ok({ at: 0 })).toBe(false);
		expect(ok({ at: 1.5 })).toBe(false);
		expect(ok({ subagent_type: "" })).toBe(false);
		expect(ok({ prompt: "secret" })).toBe(false);
	});

	test("trims the type and cuts it to 64 characters rather than refusing it", () => {
		const parse = (subagent_type: string) =>
			CodingAgentSubagentPost.parse(post({ subagent_type })).subagent_type;
		expect(parse("  Explore ")).toBe("Explore");
		expect(parse("t".repeat(64))).toBe("t".repeat(64));
		expect(parse("t".repeat(200))).toBe("t".repeat(64));
		expect(parse("😀".repeat(100))).toBe("😀".repeat(64));
		// Only blanks leave no type, so the board falls back to its default.
		expect(parse("   ")).toBeUndefined();
	});

	test("trims the description and cuts it to 120 characters", () => {
		const parse = (description: string) =>
			CodingAgentSubagentPost.parse(post({ description })).description;
		expect(parse("  padded  ")).toBe("padded");
		expect(parse("d".repeat(120))).toBe("d".repeat(120));
		expect(parse("d".repeat(500))).toBe("d".repeat(120));
		// A cut never splits a character made of two code units.
		expect(parse("😀".repeat(200))).toBe("😀".repeat(120));
		expect(parse(`${"d".repeat(119)} ${"e".repeat(10)}`)).toBe("d".repeat(119));
	});
});

const plan = (change: object = {}) => ({
	id: "claude",
	label: "Claude",
	usedPercent: 40,
	resetsAt: inDays(3),
	observedAt: NOW,
	...change,
});

describe("plan usage", () => {
	const ok = (change?: object) => PlanUsage.safeParse(plan(change)).success;

	test("keeps its percent in 0..100", () => {
		expect(ok({ usedPercent: 0 })).toBe(true);
		expect(ok({ usedPercent: 100 })).toBe(true);
		expect(ok({ usedPercent: -1 })).toBe(false);
		expect(ok({ usedPercent: 100.5 })).toBe(false);
	});

	test("resets within 31 days", () => {
		expect(ok({ resetsAt: inDays(30) })).toBe(true);
		expect(ok({ resetsAt: inDays(32) })).toBe(false);
		expect(ok({ resetsAt: "soon" })).toBe(false);
	});

	test("has a lowercase id of 1 to 32 characters and a label of 1 to 32", () => {
		expect(ok({ id: "codex-2" })).toBe(true);
		expect(ok({ id: "a".repeat(32) })).toBe(true);
		expect(ok({ id: "a".repeat(33) })).toBe(false);
		expect(ok({ id: "" })).toBe(false);
		expect(ok({ id: "Claude" })).toBe(false);
		expect(ok({ id: "1claude" })).toBe(false);
		expect(ok({ label: "" })).toBe(false);
		expect(ok({ label: "l".repeat(32) })).toBe(true);
		expect(ok({ label: "l".repeat(33) })).toBe(false);
		expect(ok({ observedAt: "now" })).toBe(false);
	});
});

test("the limits report lists at most eight providers", () => {
	const report = (count: number) => ({
		providers: Array.from({ length: count }, (_, i) => plan({ id: `p${i}` })),
	});
	expect(AgentLimitsReport.safeParse(report(0)).success).toBe(true);
	expect(AgentLimitsReport.safeParse(report(8)).success).toBe(true);
	expect(AgentLimitsReport.safeParse(report(9)).success).toBe(false);
	expect(AgentLimitsReport.safeParse({ claude: null, codex: null }).success).toBe(
		false,
	);
});

describe("the meter", () => {
	const counts = {
		sessions: 1,
		inputTokens: 2,
		outputTokens: 3,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		costUsd: null,
		linesAdded: 0,
		linesRemoved: 0,
	};

	test("lists providers whose plan and counts may each be null", () => {
		expect(
			AgentMeter.safeParse({
				providers: [
					{ id: "claude", label: "Claude", plan: plan(), today: null },
					{ id: "codex", label: "Codex", plan: null, today: counts },
				],
			}).success,
		).toBe(true);
		expect(AgentMeter.safeParse({ providers: [] }).success).toBe(true);
	});

	test("lists at most eight providers and needs a valid id", () => {
		const entry = (id: string) => ({ id, label: "L", plan: null, today: null });
		const meter = (count: number) => ({
			providers: Array.from({ length: count }, (_, i) => entry(`p${i}`)),
		});
		expect(AgentMeter.safeParse(meter(8)).success).toBe(true);
		expect(AgentMeter.safeParse(meter(9)).success).toBe(false);
		expect(AgentMeter.safeParse({ providers: [entry("Bad Id")] }).success).toBe(false);
		expect(
			AgentMeter.safeParse({ providers: [{ ...entry("x"), plan: undefined }] }).success,
		).toBe(false);
	});
});

describe("chat titles", () => {
	test("a title is one line with no control characters, cut at 80 without splitting a character", () => {
		expect(agentTitleText(" Fix\r\nthe\u0007\tbuild  ")).toBe("Fix the build");
		expect(agentTitleText("\u0000 \n")).toBe("");
		// Invisible format characters could reorder or hide text on screen.
		expect(agentTitleText("fix \u202Etxt.exe\u202C now")).toBe("fix txt.exe now");
		expect(agentTitleText("a\u200Bb\uFEFFc")).toBe("a b c");
		expect(agentTitleText("\u200B\u2066")).toBe("");
		const cut = agentTitleText(`${"a".repeat(79)}😀b`);
		expect(cut).toBe("a".repeat(79));
	});

	test("a status may carry a title of 1 to 80 characters", () => {
		expect(AgentCodingAgentStatus.parse({ ...status(), title: "Fix it" }).title).toBe(
			"Fix it",
		);
		expect(AgentCodingAgentStatus.safeParse({ ...status(), title: "" }).success).toBe(
			false,
		);
		expect(
			AgentCodingAgentStatus.safeParse({ ...status(), title: "x".repeat(81) }).success,
		).toBe(false);
	});

	test("a title post is cleaned, and a blank one means no title", () => {
		const terminal = status().terminalId;
		expect(CodingAgentTitlePost.parse({ terminal, title: " a\nb " }).title).toBe("a b");
		expect(CodingAgentTitlePost.parse({ terminal, title: " \t" }).title).toBeNull();
		expect(CodingAgentTitlePost.parse({ terminal, title: null }).title).toBeNull();
	});

	test("rename carries a title of 1 to 80 characters and nothing else", () => {
		expect(ChatClientMessage.safeParse({ type: "rename", title: "New" }).success).toBe(
			true,
		);
		expect(ChatClientMessage.safeParse({ type: "rename", title: "" }).success).toBe(
			false,
		);
		expect(
			ChatClientMessage.safeParse({ type: "rename", title: "x".repeat(81) }).success,
		).toBe(false);
		expect(
			ChatClientMessage.safeParse({ type: "rename", title: "a", extra: 1 }).success,
		).toBe(false);
	});
});
