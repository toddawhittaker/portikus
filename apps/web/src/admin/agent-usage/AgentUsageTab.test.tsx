import { fireEvent, screen, waitFor, within } from "@testing-library/react";
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

const PERSON = "11111111-1111-4111-8111-111111111111";

const AI_USAGE = {
	days: 7,
	from: "2026-10-04",
	to: "2026-10-10",
	users: [
		{
			userId: PERSON,
			displayName: "Alice Student",
			purpose: "assistant",
			model: "claude-opus-5-5",
			inputTokens: 1_000_000,
			outputTokens: 40_000,
			cacheReadTokens: 2_000_000,
			cacheWriteTokens: 800_000,
		},
		{
			userId: null,
			displayName: "Weekly price check",
			purpose: "pricing",
			model: "mystery-model",
			inputTokens: 900,
			outputTokens: 80,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
		},
	],
	daily: [],
	totals: {
		inputTokens: 1_000_900,
		outputTokens: 40_080,
		cacheReadTokens: 2_000_000,
		cacheWriteTokens: 800_000,
	},
	dollars: null,
	month: { usedTokens: 1_500_000, capTokens: 5_000_000 },
};

/** Answers each of the tab's two requests; the agent usage can be swapped per test. */
function serve(
	agent: object | ((url: string) => object) = USAGE,
	ai: object = AI_USAGE,
) {
	return stubFetch((url) => {
		if (url.startsWith("/admin/ai-usage")) return json(200, ai);
		return json(200, typeof agent === "function" ? agent(url) : agent);
	});
}

test("shows a row per person and agent, a dash for Codex's cost, and the daily totals", async () => {
	const fetch = serve();
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
	expect(fetch.mock.calls.map((call) => String(call[0]))).toContain(
		"/admin/agent-usage?days=7",
	);
});

test("both tables use one column plan, one column per header", async () => {
	serve();
	renderWithQuery(<AgentUsageTab />);
	const people = await screen.findByRole("table", { name: /Agent usage per person/ });
	const daily = screen.getByRole("table", { name: /Agent usage per day/ });

	const plan = (table: HTMLElement) =>
		[...table.querySelectorAll("colgroup col")].map((col) => col.className);
	expect(plan(people)).toEqual(plan(daily));
	expect(plan(people)).toHaveLength(people.querySelectorAll("thead th").length);
	expect(people.className).toBe(daily.className);
});

test("an empty period says so and shows no tables", async () => {
	serve({ ...USAGE, users: [], daily: [] }, { ...AI_USAGE, users: [] });
	renderWithQuery(<AgentUsageTab />);

	expect(await screen.findByTestId("agent-usage-empty")).toBeDefined();
	expect(screen.queryByRole("table")).toBeNull();
});

test("the intro says counts never include prompts or code", async () => {
	serve();
	renderWithQuery(<AgentUsageTab />);

	expect(await screen.findByText(/never include prompts or code/)).toBeDefined();
});

test("a new period is announced once its totals show", async () => {
	serve((url) => {
		const days = Number(new URL(url, "http://x").searchParams.get("days"));
		return { ...USAGE, days };
	});
	renderWithQuery(<AgentUsageTab />);
	await screen.findByRole("table", { name: /Agent usage per person/ });
	const status = screen.getByTestId("agent-usage-days-status");
	expect(status.textContent).toBe("");

	fireEvent.click(screen.getByRole("combobox", { name: "Period" }));
	fireEvent.click(await screen.findByRole("option", { name: "Last 30 days" }));
	await waitFor(() => expect(status.textContent).toBe("Showing the last 30 days."));
});

test("the Built-in assistant section shows the month against the cap and a row per person", async () => {
	serve();
	renderWithQuery(<AgentUsageTab />);

	const section = within(await screen.findByTestId("ai-usage"));
	expect(
		await section.findByRole("heading", { name: "Built-in assistant" }),
	).toBeDefined();
	const meter = await section.findByRole("meter", { name: "Used this month" });
	expect(meter.getAttribute("aria-valuetext")).toBe("1,500,000 of 5,000,000 tokens");

	const table = await section.findByRole("table", {
		name: /Built-in assistant use per person/,
	});
	const rows = within(table).getAllByRole("row").slice(1);
	expect(rows).toHaveLength(2);
	const alice = within(rows[0] as HTMLElement);
	expect(alice.getByText("Alice Student")).toBeDefined();
	expect(alice.getByText("Assistant")).toBeDefined();
	expect(alice.getByText("1,000,000")).toBeDefined();
	// Cache reads and writes are added: 2,000,000 + 800,000.
	expect(alice.getByText("2,800,000")).toBeDefined();
	const check = within(rows[1] as HTMLElement);
	expect(check.getByText("Weekly price check")).toBeDefined();
	expect(check.getByText("Price check")).toBeDefined();
	// Tokens only: a cost without output tokens would undercount.
	expect(screen.queryByText(/Estimated input cost/)).toBeNull();
	expect(within(table).queryByText(/\$/)).toBeNull();
});

test("the assistant section asks for the chosen period and says when nothing was used", async () => {
	const fetch = serve(USAGE, { ...AI_USAGE, users: [] });
	renderWithQuery(<AgentUsageTab />);

	expect(await screen.findByTestId("ai-usage-empty")).toBeDefined();
	expect(fetch.mock.calls.map((call) => String(call[0]))).toContain(
		"/admin/ai-usage?days=7",
	);
	expect(screen.queryByRole("table", { name: /Built-in assistant/ })).toBeNull();
});
