import { screen, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { json, renderWithQuery, stubFetch } from "../../test-utils.js";
import { AgentUsageTab } from "./AgentUsageTab.js";

afterEach(() => vi.unstubAllGlobals());

const COUNTS = {
	sessions: 3,
	inputTokens: 1200,
	outputTokens: 3400,
	cacheReadTokens: 5600,
	cacheWriteTokens: 780,
	linesAdded: 90,
	linesRemoved: 12,
};

const USAGE = {
	days: 7,
	from: "2026-10-04",
	to: "2026-10-10",
	users: [
		{
			userId: "11111111-1111-4111-8111-111111111111",
			displayName: "Alice Student",
			agent: "claude",
			costUsd: 4.5,
			...COUNTS,
		},
		{
			userId: "11111111-1111-4111-8111-111111111111",
			displayName: "Alice Student",
			agent: "codex",
			costUsd: null,
			...COUNTS,
		},
	],
	daily: [{ day: "2026-10-09", agent: "claude", costUsd: 4.5, ...COUNTS }],
};

test("shows a row per person and agent, a dash for Codex's cost, and the daily totals", async () => {
	const fetch = stubFetch(() => json(200, USAGE));
	renderWithQuery(<AgentUsageTab />);

	const table = await screen.findByRole("table", { name: /Agent usage per person/ });
	const rows = within(table).getAllByRole("row").slice(1);
	expect(rows).toHaveLength(2);
	expect(within(rows[0] as HTMLElement).getByText("Claude Code")).toBeDefined();
	expect(within(rows[0] as HTMLElement).getByText("$4.50")).toBeDefined();
	expect(within(rows[0] as HTMLElement).getByText("1,200")).toBeDefined();
	expect(within(rows[1] as HTMLElement).getByText("—")).toBeDefined();
	expect(
		within(table).getByRole("button", { name: "About Estimated API cost" }),
	).toBeDefined();
	expect(screen.getByRole("table", { name: /Agent usage per day/ })).toBeDefined();
	expect(String(fetch.mock.calls[0]?.[0])).toBe("/admin/agent-usage?days=7");
});

test("an empty period says so and shows no tables", async () => {
	stubFetch(() => json(200, { ...USAGE, users: [], daily: [] }));
	renderWithQuery(<AgentUsageTab />);

	expect(await screen.findByTestId("agent-usage-empty")).toBeDefined();
	expect(screen.queryByRole("table")).toBeNull();
});

test("the intro says counts never include prompts or code", async () => {
	stubFetch(() => json(200, USAGE));
	renderWithQuery(<AgentUsageTab />);

	expect(await screen.findByText(/never include prompts or code/)).toBeDefined();
});
