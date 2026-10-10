import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { json, renderWithQuery, stubFetch } from "../test-utils.js";
import { CourseUsage } from "./CourseUsage.js";

afterEach(() => vi.unstubAllGlobals());

const COURSE = "55555555-5555-4555-8555-555555555555";
const COUNTS = {
	sessions: 3,
	inputTokens: 1200,
	outputTokens: 3400,
	cacheReadTokens: 5600,
	cacheWriteTokens: 780,
	linesAdded: 90,
	linesRemoved: 12,
};

function usage(days: number, withRows: boolean) {
	return {
		days,
		from: "2026-10-04",
		to: "2026-10-10",
		users: withRows
			? [
					{
						userId: "11111111-1111-4111-8111-111111111111",
						displayName: "Sam Student",
						agent: "claude",
						costUsd: 4.5,
						...COUNTS,
					},
				]
			: [],
		daily: withRows
			? [{ day: "2026-10-09", agent: "claude", costUsd: 4.5, ...COUNTS }]
			: [],
	};
}

test("shows per-person and daily tables and says counts never include prompts or code", async () => {
	stubFetch((url) =>
		url === `/courses/${COURSE}/agent-usage?days=7`
			? json(200, usage(7, true))
			: json(404, { code: "NOT_FOUND", message: "no" }),
	);
	renderWithQuery(<CourseUsage courseId={COURSE} />);

	const users = await screen.findByTestId("agent-usage-users");
	expect(within(users).getByRole("rowheader", { name: "Sam Student" })).toBeDefined();
	expect(within(users).getByText("$4.50")).toBeDefined();
	expect(
		within(users).getByRole("button", { name: "About Estimated API cost" }),
	).toBeDefined();
	expect(screen.getByTestId("agent-usage-daily")).toBeDefined();
	expect(screen.getByRole("heading", { level: 3, name: "Daily totals" })).toBeDefined();
	expect(screen.getByText(/never include prompts or code/)).toBeDefined();
});

test("choosing a longer period asks for it", async () => {
	const fetch = stubFetch((url) => {
		const days = Number(new URL(url, "http://x").searchParams.get("days"));
		return json(200, usage(days, true));
	});
	renderWithQuery(<CourseUsage courseId={COURSE} />);
	await screen.findByTestId("agent-usage-users");

	fireEvent.click(screen.getByRole("combobox", { name: "Period" }));
	fireEvent.click(await screen.findByRole("option", { name: "Last 90 days" }));
	await waitFor(() =>
		expect(fetch).toHaveBeenCalledWith(
			`/courses/${COURSE}/agent-usage?days=90`,
			expect.anything(),
		),
	);
});

test("an empty period says so", async () => {
	stubFetch(() => json(200, usage(7, false)));
	renderWithQuery(<CourseUsage courseId={COURSE} />);
	expect((await screen.findByTestId("agent-usage-empty")).textContent).toContain(
		"No agent usage was reported for this course",
	);
});

test("a failed load shows the message", async () => {
	stubFetch(() => json(500, { code: "INTERNAL", message: "Usage is down." }));
	renderWithQuery(<CourseUsage courseId={COURSE} />);
	expect((await screen.findByRole("alert")).textContent).toBe("Usage is down.");
});
