import type { AgentUsageCounts } from "@portikus/contracts";
import { expect, test } from "vitest";
import {
	chooseDisplay,
	limitWarning,
	percentText,
	shouldWarn,
	todayText,
	warnKey,
} from "./agentDisplay.js";

const NOW = Date.parse("2026-11-01T12:00:00Z");
const plan = (usedPercent: number, hours: number, id = "claude") => ({
	id,
	label: id === "claude" ? "Claude" : "Codex",
	usedPercent,
	resetsAt: new Date(NOW + hours * 3_600_000).toISOString(),
	observedAt: new Date(NOW).toISOString(),
});
const counts = (over: Partial<AgentUsageCounts> = {}): AgentUsageCounts => ({
	sessions: 2,
	inputTokens: 800_000,
	outputTokens: 400_000,
	cacheReadTokens: 5,
	cacheWriteTokens: 6,
	costUsd: 3.4,
	linesAdded: 0,
	linesRemoved: 0,
	...over,
});
const entry = (over: {
	plan?: ReturnType<typeof plan> | null;
	today?: AgentUsageCounts | null;
}) => ({
	id: "claude",
	label: "Claude",
	plan: null,
	today: null,
	...over,
});

test("a plan figure shows, and tokens and cost stay out of the choice", () => {
	expect(chooseDisplay(entry({ plan: plan(42, 90), today: counts() }), NOW)).toEqual({
		kind: "plan",
		plan: plan(42, 90),
	});
});

test("a plan past its reset is hidden, and today's counts show instead", () => {
	const stale = entry({ plan: plan(99, -1), today: counts() });
	expect(chooseDisplay(stale, NOW)?.kind).toBe("today");
	expect(chooseDisplay({ ...stale, today: null }, NOW)).toBeNull();
});

test("a plan resetting at this very moment is hidden", () => {
	expect(chooseDisplay(entry({ plan: plan(50, 0) }), NOW)).toBeNull();
});

test("with no plan, today's counts show; with neither, or counts of zero, nothing does", () => {
	expect(chooseDisplay(entry({ today: counts() }), NOW)?.kind).toBe("today");
	expect(chooseDisplay(entry({}), NOW)).toBeNull();
	expect(
		chooseDisplay(
			entry({ today: counts({ sessions: 0, inputTokens: 0, outputTokens: 0 }) }),
			NOW,
		),
	).toBeNull();
});

test("today's text has a cost only when the agent reports one", () => {
	expect(todayText(counts())).toBe("1.2M tokens · ≈$3.40");
	expect(todayText(counts({ costUsd: null, inputTokens: 900, outputTokens: 50 }))).toBe(
		"950 tokens",
	);
});

test("percent rounds down so 84.9 does not read as the warning share", () => {
	expect(percentText(84.9)).toBe("84%");
	expect(limitWarning(84.9, false)).toBe(false);
	expect(limitWarning(85, false)).toBe(true);
});

test("a warning holds until usage falls below 80%", () => {
	expect(limitWarning(82, true)).toBe(true);
	expect(limitWarning(79, true)).toBe(false);
	expect(limitWarning(82, false)).toBe(false);
});

test("a plan is warned about once per provider and reset time", () => {
	const hot = plan(90, 2);
	const seen = new Set<string>();
	expect(shouldWarn(hot, seen)).toBe(true);
	expect(shouldWarn(plan(10, 90), seen)).toBe(false);
	seen.add(warnKey(hot));
	expect(shouldWarn(hot, seen)).toBe(false);
	// Another provider, or the same plan after it resets, warns again.
	expect(shouldWarn(plan(90, 2, "codex"), seen)).toBe(true);
	expect(shouldWarn(plan(90, 9), seen)).toBe(true);
});
