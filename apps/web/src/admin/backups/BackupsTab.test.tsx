import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { json, openToggletip, renderApp, stubFetch, USER } from "../../test-utils.js";
import { ActivityGroups } from "./Activity.js";
import {
	ALICE_INSTANCE,
	backups,
	FAILED,
	NEW,
	OLD,
	stubBackups,
	view,
	WORKSPACES,
} from "./testBackups.js";

/** The Backups tab's layout, status, sets and Clean up; restores are in Restore.test.tsx. */

afterEach(() => vi.unstubAllGlobals());

test("a site whose host never reported says backups are not connected", async () => {
	stubBackups(backups({ host: null, hostReportedAt: null, hostStale: true }));
	renderApp("/admin/backups");
	expect(
		await screen.findByText("Backups are not connected on this site"),
	).toBeTruthy();
	expect(screen.queryByTestId("backup-run")).toBeNull();
});

test("an error loading the tab is shown", async () => {
	stubFetch((url) =>
		url === "/auth/me"
			? json(200, { ...USER, role: "administrator" })
			: json(500, { code: "INTERNAL", message: "Backups could not be loaded." }),
	);
	renderApp("/admin/backups");
	expect((await screen.findByRole("alert")).textContent).toBe(
		"Backups could not be loaded.",
	);
});

test("the status card shows the last run, failure, next run and key", async () => {
	stubBackups(backups());
	renderApp("/admin/backups");
	const status = await screen.findByTestId("backups-status");
	expect(within(status).getByTestId("backups-host").textContent).toMatch(/^Reporting/);
	expect(within(status).getByTestId("backups-last-run").textContent).toMatch(/^Failed/);
	expect(within(status).getByTestId("backups-last-failure").textContent).toContain(
		"the pool was busy",
	);
	expect(within(status).getByTestId("backups-running").textContent).toBe("Nothing");
	expect(within(status).getByTestId("backups-key").textContent).toBe(
		"Installed on the host",
	);
	expect(screen.queryByTestId("backups-host-stale")).toBeNull();
});

test("Back up now records a request", async () => {
	const writes = stubBackups(backups());
	renderApp("/admin/backups");
	fireEvent.click(await screen.findByTestId("backup-run"));
	await waitFor(() =>
		expect(writes).toEqual([{ method: "POST", url: "/admin/backups/run", body: null }]),
	);
});

test("a stale host turns Back up now off and says why", async () => {
	const writes = stubBackups(
		backups({ hostStale: true, hostReportedAt: "2026-09-26T09:00:00.000Z" }),
	);
	renderApp("/admin/backups");
	const run = await screen.findByTestId("backup-run");
	expect(run.getAttribute("aria-disabled")).toBe("true");
	expect(screen.getByTestId("backup-run-note").textContent).toBe(
		"Back up now waits until the host reports again.",
	);
	const stale = screen.getByTestId("backups-host-stale");
	expect(stale.textContent).toContain("The host has not reported since");
	expect(stale.classList.contains("bg-status-warning-soft")).toBe(true);
	fireEvent.click(run);
	expect(writes).toEqual([]);
});

test("a running backup turns Back up now off", async () => {
	const data = backups();
	stubBackups({ ...data, host: data.host && { ...data.host, running: "nightly" } });
	renderApp("/admin/backups");
	expect((await screen.findByTestId("backup-run")).getAttribute("aria-disabled")).toBe(
		"true",
	);
	expect(screen.getByTestId("backups-running").textContent).toBe("The nightly backup");
});

test("the newest complete set cannot be deleted; an older one can", async () => {
	const writes = stubBackups(backups());
	renderApp("/admin/backups");
	const newest = await screen.findByTestId(`backup-set-${NEW}`);
	const refused = within(newest).getByTestId("backup-set-delete");
	expect(refused.getAttribute("aria-disabled")).toBe("true");
	expect(newest.textContent).toContain("The newest complete set is always kept.");
	expect(within(newest).getByTestId(`backup-set-skipped-${NEW}`).textContent).toBe(
		" 2 volumes of no workspace skipped",
	);
	expect(screen.queryByTestId(`backup-set-skipped-${OLD}`)).toBeNull();
	fireEvent.click(refused);
	expect(screen.queryByTestId("backup-delete-dialog")).toBeNull();

	const failed = screen.getByTestId(`backup-set-${FAILED}`);
	expect(failed.textContent).toContain("Incomplete");
	expect(failed.textContent).toContain("1 volume failed");
	fireEvent.click(within(failed).getByTestId("backup-set-delete"));
	const dialog = await screen.findByTestId("backup-delete-dialog");
	fireEvent.click(within(dialog).getByTestId("dialog-confirm"));
	await waitFor(() =>
		expect(writes).toEqual([
			{ method: "DELETE", url: `/admin/backups/sets/${FAILED}`, body: null },
		]),
	);
});

test("a set with a delete waiting shows Deleting", async () => {
	const data = backups();
	stubBackups({
		...data,
		requests: [view({ kind: "delete_set", args: { stamp: OLD }, state: "pending" })],
	});
	renderApp("/admin/backups");
	const row = await screen.findByTestId(`backup-set-${OLD}`);
	// The button stays mounted, so focus on it is not lost (SPEC.md §25.8).
	const button = within(row).getByTestId("backup-set-delete");
	expect(button.textContent).toBe("Deleting…");
	expect(button.getAttribute("aria-disabled")).toBe("true");
	fireEvent.click(button);
	expect(screen.queryByTestId("backup-delete-dialog")).toBeNull();
});

test("a set that lists no workspaces says why Restore is unavailable", async () => {
	const data = backups();
	stubBackups({
		...data,
		host: data.host && {
			...data.host,
			sets: data.host.sets.map((each) =>
				each.stamp === OLD ? { ...each, instances: [] } : each,
			),
		},
	});
	renderApp("/admin/backups");
	const row = await screen.findByTestId(`backup-set-${OLD}`);
	const restore = within(row).getByTestId("backup-set-restore");
	expect(restore.getAttribute("aria-disabled")).toBe("true");
	const reason = document.getElementById(
		restore.getAttribute("aria-describedby") ?? "",
	);
	expect(reason?.textContent).toBe("No workspaces to restore from this set");
});

test("a set that is not verified is marked and cannot be restored", async () => {
	const data = backups();
	stubBackups({
		...data,
		host: data.host && {
			...data.host,
			sets: data.host.sets.map((each) =>
				each.stamp === OLD ? { ...each, verified: false } : { ...each, verified: true },
			),
		},
	});
	renderApp("/admin/backups");
	const row = await screen.findByTestId(`backup-set-${OLD}`);
	expect(row.textContent).toContain(
		"Not verified. This server's key did not make this set, so it cannot be restored.",
	);
	expect(row.textContent).not.toContain("..");
	const restore = within(row).getByTestId("backup-set-restore");
	expect(restore.getAttribute("aria-disabled")).toBe("true");
	const reason = document.getElementById(
		restore.getAttribute("aria-describedby") ?? "",
	);
	expect(reason?.textContent).toContain("cannot be restored");
	fireEvent.click(restore);
	expect(screen.queryByTestId("backup-restore-dialog")).toBeNull();
	const verified = screen.getByTestId(`backup-set-${NEW}`);
	expect(verified.textContent).not.toContain("Not verified");
	expect(
		within(verified).getByTestId("backup-set-restore").getAttribute("aria-disabled"),
	).toBeNull();
});

test("snapshots, dumps and kept homes each delete through their own route", async () => {
	const writes = stubBackups(backups());
	renderApp("/admin/backups");
	for (const testId of [
		"backup-snapshot-delete",
		"backup-dump-delete",
		"backup-kept-home-delete",
	]) {
		fireEvent.click(await screen.findByTestId(testId));
		const dialog = await screen.findByTestId("backup-delete-dialog");
		fireEvent.click(within(dialog).getByTestId("dialog-confirm"));
		await waitFor(() =>
			expect(screen.queryByTestId("backup-delete-dialog")).toBeNull(),
		);
	}
	expect(writes.map((w) => `${w.method} ${w.url}`)).toEqual([
		`DELETE /admin/backups/snapshots/${ALICE_INSTANCE}-home/pre-upgrade`,
		"DELETE /admin/backups/dumps/portikus-pre-upgrade.dump",
		`DELETE /admin/backups/kept-homes/${ALICE_INSTANCE}-home-replaced-1790000000`,
	]);
});

test("empty lists say so, and an unlisted VM says not listed yet", async () => {
	const data = backups();
	stubBackups({
		...data,
		host: data.host && { ...data.host, sets: [], dumps: [] },
		vm: null,
		requests: [],
	});
	renderApp("/admin/backups");
	expect(await screen.findByText("No backup sets yet.")).toBeTruthy();
	expect(screen.getByText("No pre-change dumps.")).toBeTruthy();
	expect(screen.getAllByText("Not listed yet.")).toHaveLength(2);
	expect(screen.getByText("No workspaces restored recently.")).toBeTruthy();
	expect(screen.getByText("No requests yet.")).toBeTruthy();
	// An empty list is one line of text, never a table of headers alone.
	expect(screen.queryAllByRole("table")).toHaveLength(0);
	expect(screen.getByTestId("backups-cleanup-count").textContent).toBe(
		"0 dumps; snapshots and kept homes not listed yet",
	);
	expect(screen.getByTestId("backups-cleanup-summary").closest("details")?.open).toBe(
		false,
	);
});

test("the page reads as Backups, Restores, Recent requests, then Clean up", async () => {
	stubBackups(backups());
	renderApp("/admin/backups");
	await screen.findByTestId("backups-status");
	const outline = screen
		.getAllByRole("heading")
		.filter((h) => ["H2", "H3", "H4"].includes(h.tagName))
		.map((h) => `${h.tagName} ${h.textContent}`);
	expect(outline).toEqual([
		"H2 Backups",
		"H3 Status and sets",
		"H4 Status",
		"H4 Backup sets",
		"H3 Restores",
		"H3 Recent requests",
		"H3 Clean up",
		"H4 Pre-change snapshots",
		"H4 Kept homes",
		"H4 Pre-change database dumps",
	]);
	// Back up now sits in the Backups group's heading row.
	const group = screen
		.getByRole("heading", { level: 3, name: "Status and sets" })
		.closest("section") as HTMLElement;
	expect(within(group).getByTestId("backup-run")).toBeTruthy();
});

test("the tab opens with its intro and each help button names what it explains", async () => {
	stubBackups(backups());
	renderApp("/admin/backups");
	await screen.findByTestId("backups-status");
	const intro = screen.getByTestId("intro-admin-backups");
	expect(intro.textContent).toContain("Docker data is not copied.");
	expect(within(intro).getByRole("link").getAttribute("href")).toBe(
		"/admin/help#admin-backups",
	);
	for (const name of [
		"About the restore key",
		"About set times",
		"About incomplete sets",
		"About Replace home",
		"About pre-change snapshots",
		"About kept homes",
		"About pre-change database dumps",
	]) {
		expect(screen.getByRole("button", { name })).toBeTruthy();
	}
	fireEvent.click(screen.getByRole("button", { name: "About set times" }));
	expect(openToggletip().textContent).toBe(
		"Set times are in UTC, because the restore folder is named with them.",
	);
});

test("Clean up is open with counts when anything is there to delete", async () => {
	stubBackups(backups());
	renderApp("/admin/backups");
	const summary = await screen.findByTestId("backups-cleanup-summary");
	expect(screen.getByTestId("backups-cleanup-count").textContent).toBe(
		"1 snapshot, 1 kept home, 1 dump",
	);
	expect(summary.closest("details")?.open).toBe(true);
});

test("Clean up is closed when snapshots, kept homes and dumps are all empty", async () => {
	const data = backups();
	stubBackups({
		...data,
		host: data.host && { ...data.host, dumps: [] },
		vm: { snapshots: [], keptHomes: [] },
	});
	renderApp("/admin/backups");
	const summary = await screen.findByTestId("backups-cleanup-summary");
	expect(screen.getByTestId("backups-cleanup-count").textContent).toBe(
		"0 snapshots, 0 kept homes, 0 dumps",
	);
	expect(summary.closest("details")?.open).toBe(false);
});

test("the Clean up heading is named alone, with its count beside it and no colon", async () => {
	stubBackups(backups());
	renderApp("/admin/backups");
	const summary = await screen.findByTestId("backups-cleanup-summary");
	expect(within(summary).getByRole("heading", { level: 3 }).textContent).toBe(
		"Clean up",
	);
	expect(summary.textContent).not.toContain(":");
});

test("with no requests, Restores and Recent requests share one Activity group", async () => {
	stubBackups({ ...backups(), requests: [] });
	renderApp("/admin/backups");
	const activity = await screen.findByTestId("backups-activity");
	expect(within(activity).getByRole("heading", { level: 3 }).textContent).toBe(
		"Activity",
	);
	expect(
		within(activity)
			.getAllByRole("heading", { level: 4 })
			.map((h) => h.textContent),
	).toEqual(["Restores", "Recent requests"]);
	expect(within(activity).getByText("No workspaces restored recently.")).toBeTruthy();
	expect(within(activity).getByText("No requests yet.")).toBeTruthy();
	expect(screen.queryByTestId("backups-restores")).toBeNull();
	expect(screen.queryByRole("heading", { level: 3, name: "Restores" })).toBeNull();
});

test("focus inside Activity moves to the Restores heading when the first request splits it", () => {
	const { rerender } = render(
		<ActivityGroups requests={[]} workspaces={WORKSPACES} onReplace={() => {}} />,
	);
	screen.getByRole("button", { name: /Replace home/ }).focus();
	rerender(
		<ActivityGroups
			requests={[view({ state: "pending" })]}
			workspaces={WORKSPACES}
			onReplace={() => {}}
		/>,
	);
	expect(document.activeElement).toBe(
		screen.getByRole("heading", { level: 3, name: "Restores" }),
	);
});

test("with requests, Restores and Recent requests are their own groups", async () => {
	stubBackups(backups());
	renderApp("/admin/backups");
	await screen.findByTestId("backups-restores");
	expect(screen.queryByTestId("backups-activity")).toBeNull();
	expect(
		screen.getByRole("heading", { level: 3, name: "Recent requests" }),
	).toBeTruthy();
});

test("a failed request shows its error in the recent list", async () => {
	stubBackups(backups());
	renderApp("/admin/backups");
	const list = await screen.findByTestId("backup-requests");
	expect(list.textContent).toContain("refused by the host: no such set");
});
