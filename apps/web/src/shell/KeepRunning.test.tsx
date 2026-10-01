import type { Workspace } from "@portikus/contracts";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { json, renderWithQuery, stubFetch, WORKSPACE } from "../test-utils.js";
import {
	formatHoldEnd,
	holdActive,
	KeepRunningSection,
	keepRunningChoices,
} from "./KeepRunning.js";
import { StatusBar } from "./StatusBar.js";

afterEach(() => {
	vi.unstubAllGlobals();
});

const inHours = (hours: number) =>
	new Date(Date.now() + hours * 3_600_000).toISOString();

test("the choices stay within the cap and always offer the cap itself", () => {
	expect(keepRunningChoices(0)).toEqual([]);
	expect(keepRunningChoices(1)).toEqual([1]);
	expect(keepRunningChoices(12)).toEqual([1, 2, 3, 4, 6, 8, 12]);
	expect(keepRunningChoices(10)).toEqual([1, 2, 3, 4, 6, 8, 10]);
	expect(keepRunningChoices(168).at(-1)).toBe(168);
});

test("the end time is shown in the student's timezone", () => {
	const at = "2026-10-01T03:30:00.000Z";
	expect(formatHoldEnd(at, "UTC")).toMatch(/3:30/);
	expect(formatHoldEnd(at, "America/New_York")).toMatch(/11:30/);
	// An unknown zone falls back to the browser's rather than failing.
	expect(formatHoldEnd(at, "Not/AZone")).toMatch(/\d:30/);
});

test("an end six days or more ahead also names its date, so a week is not read as today", () => {
	const now = Date.parse("2026-10-01T12:00:00.000Z");
	const week = new Date(now + 168 * 3_600_000).toISOString();
	const soon = new Date(now + 8 * 3_600_000).toISOString();
	expect(formatHoldEnd(week, "UTC", now)).toMatch(/Oct 8/);
	expect(formatHoldEnd(soon, "UTC", now)).not.toMatch(/Oct/);
	expect(formatHoldEnd(soon, "UTC", now)).toMatch(/8:00/);
});

test("a hold is active only while its end is ahead", () => {
	expect(holdActive({ keepRunningUntil: null })).toBe(false);
	expect(holdActive({ keepRunningUntil: inHours(1) })).toBe(true);
	expect(holdActive({ keepRunningUntil: inHours(-1) })).toBe(false);
});

function stubKeepRunning(): { method: string; body: unknown }[] {
	const calls: { method: string; body: unknown }[] = [];
	stubFetch((url, init) => {
		if (url.endsWith("/keep-running")) {
			calls.push({
				method: init?.method ?? "GET",
				body: init?.body ? JSON.parse(String(init.body)) : null,
			});
			return json(200, WORKSPACE);
		}
		return json(404, { code: "NOT_FOUND", message: "no" });
	});
	return calls;
}

test("with no hold, Keep running asks for a time within the cap", async () => {
	const calls = stubKeepRunning();
	renderWithQuery(
		<KeepRunningSection workspaceId={WORKSPACE.id} workspace={WORKSPACE} />,
	);

	expect(screen.getByRole("heading", { name: "Keep running" })).toBeDefined();
	expect(screen.queryByTestId("keep-running-end")).toBeNull();
	// The button names its result: the end time eight hours ahead.
	expect(screen.getByTestId("keep-running-set").textContent).toMatch(
		/^Keep running until \w{3} \d{1,2}:\d{2}/,
	);
	const before = Date.now();
	fireEvent.click(screen.getByTestId("keep-running-set"));
	await waitFor(() => expect(calls.length).toBe(1));
	expect(calls[0]?.method).toBe("PUT");
	const sent = calls[0]?.body as { until: string } | undefined;
	const until = Date.parse(sent?.until ?? "");
	// Eight hours is picked first; it never passes the 12-hour cap.
	expect(until).toBeGreaterThanOrEqual(before + 8 * 3_600_000);
	expect(until).toBeLessThanOrEqual(Date.now() + 12 * 3_600_000);
});

test("with a hold, the end time shows and Don't keep running ends it", async () => {
	const calls = stubKeepRunning();
	const workspace: Workspace = { ...WORKSPACE, keepRunningUntil: inHours(3) };
	renderWithQuery(
		<KeepRunningSection workspaceId={WORKSPACE.id} workspace={workspace} />,
	);

	expect(screen.getByTestId("keep-running-status").textContent).toContain(
		formatHoldEnd(workspace.keepRunningUntil as string),
	);
	expect(screen.getByTestId("keep-running-set").textContent).toMatch(
		/^Keep running until /,
	);
	const end = screen.getByRole("button", { name: "Don't keep running" });
	expect(end.getAttribute("data-testid")).toBe("keep-running-end");
	fireEvent.click(end);
	await waitFor(() => expect(calls).toEqual([{ method: "DELETE", body: null }]));
});

test("a hold set before the cap went to 0 can still be ended, with nothing new offered", () => {
	stubKeepRunning();
	renderWithQuery(
		<KeepRunningSection
			workspaceId={WORKSPACE.id}
			workspace={{ ...WORKSPACE, keepRunningMaxHours: 0, keepRunningUntil: inHours(1) }}
		/>,
	);
	expect(screen.getByTestId("keep-running-status")).toBeDefined();
	expect(screen.queryByTestId("keep-running-set")).toBeNull();
	expect(screen.getByRole("button", { name: "Don't keep running" })).toBeDefined();
});

test("a cap of 0 shows nothing", () => {
	stubKeepRunning();
	renderWithQuery(
		<KeepRunningSection
			workspaceId={WORKSPACE.id}
			workspace={{ ...WORKSPACE, keepRunningMaxHours: 0 }}
		/>,
	);
	expect(screen.queryByRole("heading", { name: "Keep running" })).toBeNull();
});

test("the status bar shows an active hold and opens the workspace dialog", () => {
	stubKeepRunning();
	const workspace: Workspace = { ...WORKSPACE, keepRunningUntil: inHours(2) };
	renderWithQuery(
		<StatusBar
			workspaceId={WORKSPACE.id}
			project={undefined}
			workspace={workspace}
			dialog="closed"
			onDialogChange={() => {}}
		/>,
	);
	const indicator = screen.getByTestId("keep-running-indicator");
	expect(indicator.textContent).toContain(
		`Kept running until ${formatHoldEnd(workspace.keepRunningUntil as string)}`,
	);
	expect(indicator.getAttribute("aria-haspopup")).toBe("dialog");
});

test("the status bar shows no hold once it has ended", () => {
	stubKeepRunning();
	renderWithQuery(
		<StatusBar
			workspaceId={WORKSPACE.id}
			project={undefined}
			workspace={{ ...WORKSPACE, keepRunningUntil: inHours(-1) }}
			dialog="closed"
			onDialogChange={() => {}}
		/>,
	);
	expect(screen.queryByTestId("keep-running-indicator")).toBeNull();
});
