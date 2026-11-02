import { expect, test } from "vitest";
import {
	AgentCodingAgentsChanged,
	AgentLimits,
	AgentLimitsReport,
	AgentLimitWindow,
	AgentMeter,
	CodingAgentState,
	CodingAgentTerminal,
	MAX_AGENT_LIMIT_WINDOWS,
	MAX_CODING_AGENT_TERMINALS,
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
	expect(CodingAgentTerminal.safeParse({ ...status(), projectId }).success).toBe(true);
	expect(CodingAgentTerminal.safeParse(status()).success).toBe(false);
});

test("a limit window keeps its percent in 0..100", () => {
	const window = (usedPercent: number) => ({
		name: "5h",
		usedPercent,
		resetsAt: inDays(1),
	});
	expect(AgentLimitWindow.safeParse(window(0)).success).toBe(true);
	expect(AgentLimitWindow.safeParse(window(100)).success).toBe(true);
	expect(AgentLimitWindow.safeParse(window(-1)).success).toBe(false);
	expect(AgentLimitWindow.safeParse(window(100.5)).success).toBe(false);
});

test("a limit window resets within 31 days", () => {
	const window = (resetsAt: string) => ({ name: "7d", usedPercent: 10, resetsAt });
	expect(AgentLimitWindow.safeParse(window(inDays(30))).success).toBe(true);
	expect(AgentLimitWindow.safeParse(window(inDays(32))).success).toBe(false);
	expect(AgentLimitWindow.safeParse(window("soon")).success).toBe(false);
});

test("a limit window name is short", () => {
	const base = { usedPercent: 10, resetsAt: inDays(1) };
	expect(AgentLimitWindow.safeParse({ ...base, name: "" }).success).toBe(false);
	expect(AgentLimitWindow.safeParse({ ...base, name: "x".repeat(17) }).success).toBe(
		false,
	);
	expect(AgentLimitWindow.safeParse({ ...base, name: "5h" }).success).toBe(true);
});

test("an agent reports at most four limit windows", () => {
	const limits = (count: number) => ({
		windows: Array.from({ length: count }, () => ({
			name: "5h",
			usedPercent: 1,
			resetsAt: inDays(1),
		})),
		observedAt: NOW,
	});
	expect(MAX_AGENT_LIMIT_WINDOWS).toBe(4);
	expect(AgentLimits.safeParse(limits(4)).success).toBe(true);
	expect(AgentLimits.safeParse(limits(5)).success).toBe(false);
});

test("the limits report allows null for an agent that reports none", () => {
	expect(AgentLimitsReport.safeParse({ claude: null, codex: null }).success).toBe(true);
	expect(AgentLimitsReport.safeParse({ claude: null }).success).toBe(false);
});

test("the meter carries limits and counts, each of which may be null", () => {
	expect(
		AgentMeter.safeParse({
			agents: [
				{ agent: "claude", limits: null, today: null },
				{
					agent: "codex",
					limits: null,
					today: {
						sessions: 1,
						inputTokens: 2,
						outputTokens: 3,
						cacheReadTokens: 0,
						cacheWriteTokens: 0,
						costUsd: null,
						linesAdded: 0,
						linesRemoved: 0,
					},
				},
			],
		}).success,
	).toBe(true);
});
