import type { CodingAgentTerminal } from "@portikus/contracts";
import { expect, test } from "vitest";
import { agentRowName, agentsByProject, shortElapsed } from "./ProjectAgents";

function row(overrides: Partial<CodingAgentTerminal>): CodingAgentTerminal {
	return {
		terminalId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
		projectId: "p1",
		name: "Terminal 2",
		kind: "terminal",
		agent: "claude",
		state: "working",
		since: "2026-11-01T10:00:00.000Z",
		subagents: [],
		...overrides,
	};
}

test("a row's time is short: seconds, then minutes, then hours and minutes", () => {
	expect(shortElapsed(-500)).toBe("0s");
	expect(shortElapsed(59_999)).toBe("59s");
	expect(shortElapsed(4 * 60_000 + 30_000)).toBe("4m");
	expect(shortElapsed(59 * 60_000)).toBe("59m");
	expect(shortElapsed(65 * 60_000)).toBe("1h 5m");
});

test("a row is named as its tab is, not by the terminal's stored name", () => {
	expect(agentRowName(row({}))).toBe("Claude Code (TUI)");
	expect(agentRowName(row({ kind: "chat" }))).toBe("Claude Code (GUI)");
	expect(agentRowName(row({ agent: "codex" }))).toBe("Codex");
});

test("rows are grouped by project in the order they came", () => {
	const a = row({ terminalId: "a", projectId: "p1" });
	const b = row({ terminalId: "b", projectId: "p2" });
	const c = row({ terminalId: "c", projectId: "p1" });
	const grouped = agentsByProject([a, b, c]);
	expect(grouped.get("p1")).toEqual([a, c]);
	expect(grouped.get("p2")).toEqual([b]);
});
