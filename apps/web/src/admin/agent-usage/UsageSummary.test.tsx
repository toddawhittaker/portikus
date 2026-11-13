import { render, screen, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { DailyChart, daysBetween, UsageSummary, usageTotals } from "./UsageSummary.js";

const COUNTS = {
	sessions: 3,
	inputTokens: 1200,
	outputTokens: 3400,
	cacheReadTokens: 5600,
	cacheWriteTokens: 780,
	linesAdded: 90,
	linesRemoved: 12,
};

const DATA = {
	days: 7 as const,
	from: "2026-10-04",
	to: "2026-10-10",
	users: [
		{
			userId: "a",
			displayName: "Alice",
			agent: "claude" as const,
			costUsd: 4.5,
			...COUNTS,
		},
		{
			userId: "a",
			displayName: "Alice",
			agent: "codex" as const,
			costUsd: null,
			...COUNTS,
		},
	],
	daily: [
		{ day: "2026-10-09", agent: "claude" as const, costUsd: 4.5, ...COUNTS },
		{ day: "2026-10-09", agent: "codex" as const, costUsd: null, ...COUNTS },
	],
};

test("the totals add every row, and the cost only the rows that report one", () => {
	expect(usageTotals(DATA.users)).toEqual({
		sessions: 6,
		inputTokens: 2400,
		outputTokens: 6800,
		linesAdded: 180,
		linesRemoved: 24,
		costUsd: 4.5,
	});
	expect(usageTotals([{ ...COUNTS, costUsd: null }]).costUsd).toBeNull();
});

test("the period covers every day from its first to its last", () => {
	expect(daysBetween("2026-10-30", "2026-11-02")).toEqual([
		"2026-10-30",
		"2026-10-31",
		"2026-11-01",
		"2026-11-02",
	]);
});

test("the summary reads the totals, with added and removed lines named for screen readers", () => {
	render(<UsageSummary data={DATA} />);
	const summary = screen.getByTestId("agent-usage-summary");
	expect(within(summary).getByText("6")).toBeDefined();
	expect(within(summary).getByText("$4.50")).toBeDefined();
	expect(summary.textContent).toContain("added +180");
	expect(summary.textContent).toContain("removed −24");
});

test("the chart draws a column a day and stacks the agents, hidden from screen readers", () => {
	render(<DailyChart data={DATA} />);
	const chart = screen.getByTestId("agent-usage-chart");
	const bars = chart.querySelector(".pk-usage-bars");
	expect(bars?.getAttribute("aria-hidden")).toBe("true");
	expect(chart.querySelectorAll(".pk-usage-day")).toHaveLength(7);
	expect(chart.querySelectorAll(".pk-usage-seg")).toHaveLength(2);
	expect(screen.getByText("Tokens per day")).toBeDefined();
});
