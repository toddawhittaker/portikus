import { EDITOR_SETTINGS_DEFAULTS } from "@portikus/contracts";
import { screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { json, renderWithQuery, stubFetch } from "../test-utils.js";
import { AgentMeters } from "./AgentMeter.js";

const future = (hours: number) =>
	new Date(Date.now() + hours * 3_600_000).toISOString();
const COUNTS = {
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

test("limits show a meter of the fullest window, with every live window in the details", async () => {
	serve({
		agents: [
			{
				agent: "claude",
				limits: {
					windows: [
						{ name: "5h", usedPercent: 42.7, resetsAt: future(2) },
						{ name: "7d", usedPercent: 10, resetsAt: future(70) },
						{ name: "old", usedPercent: 99, resetsAt: future(-1) },
					],
					observedAt: new Date().toISOString(),
				},
				today: null,
			},
			{ agent: "codex", limits: null, today: null },
		],
	});
	renderWithQuery(<AgentMeters workspaceId="w1" enabled />);
	const button = await screen.findByTestId("agent-meter-claude");
	expect(button.textContent).toContain("Claude");
	expect(button.textContent).toContain("42%");
	expect(button.getAttribute("data-level")).toBe("ok");
	expect(screen.queryByTestId("agent-meter-codex")).toBeNull();
	const rows = screen
		.getByTestId("agent-meter-claude-details")
		.querySelectorAll("tbody tr");
	expect([...rows].map((row) => row.querySelector("th")?.textContent)).toEqual([
		"5h",
		"7d",
	]);
});

test("without limits, today's counts show tokens and cost, and the details list them", async () => {
	serve({
		agents: [
			{ agent: "claude", limits: null, today: COUNTS },
			{ agent: "codex", limits: null, today: { ...COUNTS, costUsd: null } },
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

test("an agent with neither limits nor counts renders nothing", async () => {
	const fetchMock = stubFetch(() =>
		json(200, {
			agents: [
				{ agent: "claude", limits: null, today: null },
				{ agent: "codex", limits: null, today: null },
			],
		}),
	);
	renderWithQuery(<AgentMeters workspaceId="w1" enabled />);
	await waitFor(() => expect(fetchMock).toHaveBeenCalled());
	expect(screen.queryByTestId("agent-meter-claude")).toBeNull();
});

test("crossing the warning share shows one warning toast per window and reset time", async () => {
	serve({
		agents: [
			{
				agent: "claude",
				limits: {
					windows: [{ name: "5h", usedPercent: 91, resetsAt: future(2) }],
					observedAt: new Date().toISOString(),
				},
				today: null,
			},
			{ agent: "codex", limits: null, today: null },
		],
	});
	const client = renderWithQuery(<AgentMeters workspaceId="w1" enabled />);
	expect(await screen.findByText("Claude usage is at 91%")).toBeTruthy();
	expect(screen.getByTestId("agent-meter-claude").getAttribute("data-level")).toBe(
		"warning",
	);
	await client.invalidateQueries();
	await waitFor(() =>
		expect(screen.getAllByText("Claude usage is at 91%")).toHaveLength(1),
	);
});

test("a Traditional course shows no agent meters", async () => {
	stubFetch((url) =>
		url.endsWith("/agent-meter")
			? json(200, {
					agents: [
						{ agent: "claude", limits: null, today: COUNTS },
						{ agent: "codex", limits: null, today: null },
					],
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
