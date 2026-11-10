/** The limits store keeps each provider's 7-day window only (SPEC.md §10.8). */
import { AgentLimitsReport } from "@portikus/contracts";
import { expect, test } from "vitest";
import {
	AgentLimits,
	AgentLimitsStore,
	AgentLimitWindow,
	MAX_AGENT_LIMIT_WINDOWS,
	planUsage,
} from "./agent-limits-route.js";

// The contract bounds a reset by the real clock.
const inHours = (hours: number) =>
	new Date(Date.now() + hours * 3_600_000).toISOString();
const observedAt = new Date().toISOString();
const FIVE_HOUR = { name: "5h", usedPercent: 42, resetsAt: inHours(3) };
const WEEK = { name: "7d", usedPercent: 18.5, resetsAt: inHours(72) };
const limits = (...windows: AgentLimits["windows"]): AgentLimits => ({
	windows,
	observedAt,
});

test("a provider's plan usage is its 7-day window, whatever else it reports", () => {
	expect(planUsage("claude", limits(FIVE_HOUR, WEEK))).toEqual({
		id: "claude",
		label: "Claude",
		usedPercent: 18.5,
		resetsAt: WEEK.resetsAt,
		observedAt,
	});
	expect(planUsage("codex", limits(WEEK))?.label).toBe("Codex");
});

test("a provider with no 7-day window, or no limits, has no plan usage", () => {
	expect(planUsage("claude", limits(FIVE_HOUR))).toBeNull();
	expect(planUsage("claude", limits())).toBeNull();
	expect(planUsage("codex", null)).toBeNull();
});

test("the report lists the providers that have a 7-day window, in the contract's shape", async () => {
	const store = new AgentLimitsStore({ codex: async () => limits(FIVE_HOUR, WEEK) });
	expect(await store.report()).toEqual({
		providers: [expect.objectContaining({ id: "codex" })],
	});
	store.setClaude(limits(WEEK));
	const report = AgentLimitsReport.parse(await store.report());
	expect(report.providers.map((one) => one.id)).toEqual(["claude", "codex"]);
});

test("a store with nothing reports an empty list", async () => {
	expect(await new AgentLimitsStore().report()).toEqual({ providers: [] });
});

test("a limit window keeps its percent in 0..100", () => {
	const window = (usedPercent: number) => ({
		name: "5h",
		usedPercent,
		resetsAt: inHours(24),
	});
	expect(AgentLimitWindow.safeParse(window(0)).success).toBe(true);
	expect(AgentLimitWindow.safeParse(window(100)).success).toBe(true);
	expect(AgentLimitWindow.safeParse(window(-1)).success).toBe(false);
	expect(AgentLimitWindow.safeParse(window(100.5)).success).toBe(false);
});

test("a limit window resets within 31 days", () => {
	const window = (resetsAt: string) => ({ name: "7d", usedPercent: 10, resetsAt });
	expect(AgentLimitWindow.safeParse(window(inHours(30 * 24))).success).toBe(true);
	expect(AgentLimitWindow.safeParse(window(inHours(32 * 24))).success).toBe(false);
	expect(AgentLimitWindow.safeParse(window("soon")).success).toBe(false);
});

test("a limit window name is short", () => {
	const base = { usedPercent: 10, resetsAt: inHours(24) };
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
			resetsAt: inHours(24),
		})),
		observedAt,
	});
	expect(MAX_AGENT_LIMIT_WINDOWS).toBe(4);
	expect(AgentLimits.safeParse(limits(4)).success).toBe(true);
	expect(AgentLimits.safeParse(limits(5)).success).toBe(false);
});
