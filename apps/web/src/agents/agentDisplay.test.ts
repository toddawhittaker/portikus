import type { AgentUsageCounts } from "@portikus/contracts";
import { expect, test } from "vitest";
import {
	chooseDisplay,
	limitWarning,
	percentText,
	todayText,
	warnKey,
	windowsToWarn,
} from "./agentDisplay.js";

const NOW = Date.parse("2026-11-01T12:00:00Z");
const window = (name: string, usedPercent: number, hours: number) => ({
	name,
	usedPercent,
	resetsAt: new Date(NOW + hours * 3_600_000).toISOString(),
});
const limits = (...windows: ReturnType<typeof window>[]) => ({
	windows,
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

test("limits show the fullest live window", () => {
	const shown = chooseDisplay(
		{
			agent: "claude",
			limits: limits(window("5h", 42, 2), window("7d", 60, 90)),
			today: counts(),
		},
		NOW,
	);
	expect(shown).toMatchObject({ kind: "limits", top: { name: "7d" } });
});

test("a window past its reset is hidden, and the next fullest shows", () => {
	const shown = chooseDisplay(
		{
			agent: "claude",
			limits: limits(window("5h", 99, -1), window("7d", 10, 90)),
			today: null,
		},
		NOW,
	);
	expect(shown).toMatchObject({ kind: "limits", top: { name: "7d" } });
});

test("with every window expired, limits count as unknown and today's counts show", () => {
	const entry = {
		agent: "claude" as const,
		limits: limits(window("5h", 99, -1)),
		today: counts(),
	};
	expect(chooseDisplay(entry, NOW)?.kind).toBe("today");
	expect(chooseDisplay({ ...entry, today: null }, NOW)).toBeNull();
});

test("no limits and no counts is hidden, as are counts of zero", () => {
	expect(chooseDisplay({ agent: "codex", limits: null, today: null }, NOW)).toBeNull();
	expect(
		chooseDisplay(
			{
				agent: "codex",
				limits: null,
				today: counts({ sessions: 0, inputTokens: 0, outputTokens: 0 }),
			},
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

test("a window is warned about once per agent, window and reset time", () => {
	const hot = window("5h", 90, 2);
	const seen = new Set<string>();
	expect(windowsToWarn("claude", [hot, window("7d", 10, 90)], seen)).toEqual([hot]);
	seen.add(warnKey("claude", hot));
	expect(windowsToWarn("claude", [hot], seen)).toEqual([]);
	// Another agent, or the same window after it resets, warns again.
	expect(windowsToWarn("codex", [hot], seen)).toEqual([hot]);
	const nextReset = { ...hot, resetsAt: new Date(NOW + 9 * 3_600_000).toISOString() };
	expect(windowsToWarn("claude", [nextReset], seen)).toEqual([nextReset]);
});
