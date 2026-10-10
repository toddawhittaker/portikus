import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { json, renderApp, stubFetch, USER } from "../test-utils.js";

afterEach(() => vi.unstubAllGlobals());

const COURSE = {
	id: "55555555-5555-4555-8555-555555555555",
	title: "CS 101 Intro to Programming",
	platformName: "canvas",
};
const SAM_ID = "77777777-7777-4777-8777-777777777777";
const PROJECT = "88888888-8888-4888-8888-888888888888";
const SYNCED = "2026-10-10T09:00:00.000Z";

const SAM = {
	status: "active",
	userId: SAM_ID,
	displayName: "Sam Student",
	role: "student",
	lastLaunchAt: "2026-10-09T09:00:00.000Z",
	workspaceState: "running",
};
const ROSA = {
	status: "not_started",
	userId: null,
	displayName: "Rosa Roster",
	role: "student",
	lastLaunchAt: null,
	workspaceState: null,
};
const COUNTS = {
	matched: 1,
	notStarted: 1,
	removed: 2,
	roleChanged: 3,
};

const COUNTS_TEXT = "1 matched, 1 not started, 2 removed, 3 role changed.";

function members(roster: unknown, list: unknown[] = [SAM, ROSA]) {
	return json(200, { course: COURSE, roster, members: list });
}

function serve(options: {
	roster: unknown;
	sync?: () => Response | Promise<Response>;
	shares?: unknown[];
}) {
	return stubFetch((url, init) => {
		if (url === "/auth/me") return json(200, { ...USER, role: "instructor" });
		if (url === `/courses/${COURSE.id}/members`) return members(options.roster);
		if (url === `/courses/${COURSE.id}/shares`)
			return json(200, { shares: options.shares ?? [] });
		if (url === `/courses/${COURSE.id}/roster/sync` && init?.method === "POST")
			return (options.sync ?? (() => json(500, { code: "X", message: "no" })))();
		if (url.startsWith(`/courses/${COURSE.id}/agent-usage`))
			return json(200, {
				days: 7,
				from: "2026-10-04",
				to: "2026-10-10",
				users: [],
				daily: [],
			});
		return json(404, { code: "NOT_FOUND", message: "no" });
	});
}

test("a roster-only person reads Not started and has no actions", async () => {
	serve({ roster: { available: true, syncedAt: SYNCED, result: "ok" } });
	renderApp(`/course/${COURSE.id}`);

	const table = await screen.findByTestId("course-members");
	const row = within(table).getByRole("row", { name: /Rosa Roster/ });
	expect(within(row).getByText("Not started")).toBeDefined();
	expect(within(row).queryByRole("button")).toBeNull();
	expect(within(row).queryByRole("link")).toBeNull();
});

test("a member with an open share links to the shared project", async () => {
	serve({
		roster: { available: true, syncedAt: SYNCED, result: "ok" },
		shares: [
			{
				projectId: PROJECT,
				projectName: "todo-app",
				userId: SAM_ID,
				displayName: "Sam Student",
				startedAt: SYNCED,
				endsAt: "2026-10-10T17:00:00.000Z",
				workspaceState: "running",
			},
		],
	});
	renderApp(`/course/${COURSE.id}`);

	const link = await screen.findByRole("link", { name: /Shared project/ });
	expect(link.getAttribute("href")).toBe(`/course/${COURSE.id}/shares/${PROJECT}`);
	expect(link.textContent).toBe("Shared project: todo-app by Sam Student");
	const row = link.closest("tr") as HTMLElement;
	expect(within(row).getByRole("rowheader").textContent).toContain("Sam Student");
});

test("with no token URL, the page says why it cannot sync", async () => {
	serve({ roster: { available: false, syncedAt: null, result: null } });
	renderApp(`/course/${COURSE.id}`);

	expect((await screen.findByTestId("roster-unavailable")).textContent).toContain(
		"no token URL",
	);
	expect(screen.queryByRole("button", { name: "Sync roster" })).toBeNull();
});

test("the status line gives the last sync time and result in words", async () => {
	serve({ roster: { available: true, syncedAt: SYNCED, result: "token_failed" } });
	renderApp(`/course/${COURSE.id}`);

	const status = await screen.findByTestId("roster-status");
	expect(status.textContent).toContain("Last synced");
	expect(status.textContent).toContain("refused Portikus's request for access");
	expect(status.querySelector("time")?.getAttribute("datetime")).toBe(SYNCED);
});

test("a roster never synced says so", async () => {
	serve({ roster: { available: true, syncedAt: null, result: null } });
	renderApp(`/course/${COURSE.id}`);

	expect((await screen.findByTestId("roster-status")).textContent).toContain(
		"Not synced yet.",
	);
});

test("Sync roster is disabled while it runs, then announces the counts", async () => {
	let finish: (response: Response) => void = () => {};
	serve({
		roster: { available: true, syncedAt: null, result: null },
		sync: () =>
			new Promise<Response>((resolve) => {
				finish = resolve;
			}),
	});
	renderApp(`/course/${COURSE.id}`);

	fireEvent.click(await screen.findByRole("button", { name: "Sync roster" }));
	const busy = await screen.findByRole("button", { name: "Syncing roster…" });
	expect((busy as HTMLButtonElement).disabled).toBe(true);

	finish(
		json(200, {
			roster: { available: true, syncedAt: SYNCED, result: "ok" },
			...COUNTS,
		}),
	);
	await waitFor(() =>
		expect(screen.getByTestId("roster-sync").textContent).toBe(
			`Roster synced: ${COUNTS_TEXT}`,
		),
	);
	expect(screen.getByTestId("roster-sync").getAttribute("role")).toBe("status");
	expect(
		(screen.getByRole("button", { name: "Sync roster" }) as HTMLButtonElement).disabled,
	).toBe(false);
});

test("a sync that applied nothing explains why instead of showing counts", async () => {
	serve({
		roster: { available: true, syncedAt: SYNCED, result: "ok" },
		sync: () =>
			json(200, {
				roster: { available: true, syncedAt: SYNCED, result: "empty" },
				matched: 0,
				notStarted: 0,
				removed: 0,
				roleChanged: 0,
			}),
	});
	renderApp(`/course/${COURSE.id}`);

	fireEvent.click(await screen.findByRole("button", { name: "Sync roster" }));
	await waitFor(() =>
		expect(screen.getByTestId("roster-sync").textContent).toContain(
			"Roster not synced. Your learning system sent a list with no active members",
		),
	);
});

test("a failed request shows the API's message as an alert", async () => {
	serve({
		roster: { available: true, syncedAt: SYNCED, result: "ok" },
		sync: () => json(404, { code: "NOT_FOUND", message: "This course was not found." }),
	});
	renderApp(`/course/${COURSE.id}`);

	fireEvent.click(await screen.findByRole("button", { name: "Sync roster" }));
	expect((await screen.findByRole("alert")).textContent).toBe(
		"This course was not found.",
	);
});
