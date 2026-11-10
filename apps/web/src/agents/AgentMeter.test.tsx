import { type AgentUsageCounts, EDITOR_SETTINGS_DEFAULTS } from "@portikus/contracts";
import { screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { json, renderWithQuery, stubFetch } from "../test-utils.js";
import { AgentMeters } from "./AgentMeter.js";

const future = (hours: number) =>
	new Date(Date.now() + hours * 3_600_000).toISOString();
const COUNTS: AgentUsageCounts = {
	sessions: 3,
	inputTokens: 800_000,
	outputTokens: 400_000,
	cacheReadTokens: 1000,
	cacheWriteTokens: 234,
	costUsd: 3.4,
	linesAdded: 0,
	linesRemoved: 0,
};

function serve(body: unknown) {
	stubFetch((url) => (url.endsWith("/agent-meter") ? json(200, body) : json(200, {})));
}

beforeEach(() => localStorage.clear());
afterEach(() => vi.unstubAllGlobals());

const plan = (id: "claude" | "codex", usedPercent: number, hours: number) => ({
	id,
	label: id === "claude" ? "Claude" : "Codex",
	usedPercent,
	resetsAt: future(hours),
	observedAt: new Date().toISOString(),
});
const row = (
	id: "claude" | "codex",
	over: { plan?: ReturnType<typeof plan> | null; today?: AgentUsageCounts | null } = {},
) => ({
	id,
	label: id === "claude" ? "Claude" : "Codex",
	plan: null,
	today: null,
	...over,
});

test("a plan shows its percent and reset, and the details list the 7-day limit", async () => {
	serve({
		providers: [row("claude", { plan: plan("claude", 42.7, 70) }), row("codex")],
	});
	renderWithQuery(<AgentMeters workspaceId="w1" enabled />);
	const button = await screen.findByTestId("agent-meter-claude");
	expect(button.textContent).toContain("Claude");
	expect(button.textContent).toContain("42%");
	expect(button.textContent).toMatch(/resets .+/);
	expect(button.getAttribute("data-kind")).toBe("plan");
	expect(button.getAttribute("data-level")).toBe("ok");
	expect(button.getAttribute("aria-label")).toMatch(
		/^Claude 42% of the 7-day limit, resets .+\. Show usage details$/,
	);
	expect(screen.queryByTestId("agent-meter-codex")).toBeNull();
	const details = screen.getByTestId("agent-meter-claude-details");
	expect(details.textContent).toContain("Limit7 days");
	expect(details.textContent).toContain("Used42%");
	expect(details.querySelector("time")?.getAttribute("datetime")).toMatch(/^\d{4}-/);
});

test("with a plan, tokens and cost stay out of the bar and the details", async () => {
	serve({
		providers: [row("claude", { plan: plan("claude", 10, 70), today: COUNTS })],
	});
	renderWithQuery(<AgentMeters workspaceId="w1" enabled />);
	const button = await screen.findByTestId("agent-meter-claude");
	expect(button.textContent).not.toContain("tokens");
	expect(screen.getByTestId("agent-meter-claude-details").textContent).not.toMatch(
		/tokens|Estimated cost/,
	);
});

test("a provider list holds each provider, whatever its id", async () => {
	serve({
		providers: [
			row("claude", { plan: plan("claude", 10, 70) }),
			{
				...row("codex"),
				id: "kimi",
				label: "Kimi",
				plan: { ...plan("codex", 30, 50), id: "kimi", label: "Kimi" },
			},
		],
	});
	renderWithQuery(<AgentMeters workspaceId="w1" enabled />);
	expect((await screen.findByTestId("agent-meter-kimi")).textContent).toContain("Kimi");
	expect(screen.getByTestId("agent-meter-claude").textContent).toContain("Claude");
});

test("without a plan, today's counts show tokens and cost, and the details list them", async () => {
	serve({
		providers: [
			row("claude", { today: COUNTS }),
			row("codex", { today: { ...COUNTS, costUsd: null } }),
		],
	});
	renderWithQuery(<AgentMeters workspaceId="w1" enabled />);
	expect((await screen.findByTestId("agent-meter-claude")).textContent).toBe(
		"Claude today: 1.2M tokens · ≈$3.40",
	);
	expect(screen.getByTestId("agent-meter-codex").textContent).toBe(
		"Codex today: 1.2M tokens",
	);
	const details = screen.getByTestId("agent-meter-claude-details");
	expect(details.textContent).toContain("Cache tokens1,234");
	expect(details.textContent).toContain(
		"Counts update every 5 minutes. Days start at midnight UTC.",
	);
	expect(screen.getByTestId("agent-meter-codex-details").textContent).not.toContain(
		"Estimated cost",
	);
});

test("a plan past its reset is hidden and today's counts show in its place", async () => {
	serve({
		providers: [
			row("claude", { plan: plan("claude", 99, -1), today: COUNTS }),
			row("codex"),
		],
	});
	renderWithQuery(<AgentMeters workspaceId="w1" enabled />);
	const button = await screen.findByTestId("agent-meter-claude");
	expect(button.getAttribute("data-kind")).toBe("today");
});

test("a provider with neither a plan nor counts renders nothing", async () => {
	const fetchMock = stubFetch(() =>
		json(200, { providers: [row("claude"), row("codex")] }),
	);
	renderWithQuery(<AgentMeters workspaceId="w1" enabled />);
	await waitFor(() => expect(fetchMock).toHaveBeenCalled());
	expect(screen.queryByTestId("agent-meter-claude")).toBeNull();
});

test("crossing the warning share shows one warning toast per provider and reset time", async () => {
	serve({
		providers: [row("claude", { plan: plan("claude", 91, 70) }), row("codex")],
	});
	const client = renderWithQuery(<AgentMeters workspaceId="w1" enabled />);
	expect(await screen.findByText("Claude usage is at 91%")).toBeTruthy();
	expect(screen.getByText(/The 7-day limit resets/)).toBeTruthy();
	const button = screen.getByTestId("agent-meter-claude");
	expect(button.getAttribute("data-level")).toBe("warning");
	expect(button.getAttribute("aria-label")).toContain("nearly full");
	await client.invalidateQueries();
	await waitFor(() =>
		expect(screen.getAllByText("Claude usage is at 91%")).toHaveLength(1),
	);
});

test("a Traditional course shows no agent meters", async () => {
	stubFetch((url) =>
		url.endsWith("/agent-meter")
			? json(200, {
					providers: [row("claude", { today: COUNTS }), row("codex")],
				})
			: json(200, {
					...EDITOR_SETTINGS_DEFAULTS,
					appearance: "system",
					appearanceStored: true,
					timezones: ["America/New_York"],
					courseProfile: "traditional",
				}),
	);
	renderWithQuery(<AgentMeters workspaceId="w1" enabled />);
	// Agentic until the settings arrive, then hidden for good.
	await waitFor(() => expect(screen.queryByTestId("agent-meter-claude")).toBeNull());
	await new Promise((resolve) => setTimeout(resolve, 50));
	expect(screen.queryByTestId("agent-meter-claude")).toBeNull();
});
