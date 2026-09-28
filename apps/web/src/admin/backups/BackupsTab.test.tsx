import type { AdminBackups, BackupRequestView } from "@portikus/contracts";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { json, renderApp, stubFetch, USER } from "../../test-utils.js";
import {
	newestCompleteStamp,
	requestText,
	runningText,
	stampIso,
	stateText,
	waitingRequest,
	workspaceName,
} from "./model.js";

afterEach(() => vi.unstubAllGlobals());

const OLD = "20260920T023000Z";
const NEW = "20260924T023000Z";
const FAILED = "20260925T023000Z";
const ALICE_WS = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const BOB_WS = "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const ALICE_INSTANCE = `ws-${"a".repeat(24)}`;
const BOB_INSTANCE = `ws-${"b".repeat(24)}`;
const COPY_ID = "cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee";

function view(overrides: Partial<BackupRequestView>): BackupRequestView {
	return {
		id: "dddddddd-bbbb-4ccc-8ddd-eeeeeeeeeeee",
		kind: "backup",
		args: {},
		state: "done",
		requestedAt: "2026-09-26T10:00:00.000Z",
		claimedAt: null,
		finishedAt: null,
		error: null,
		workspaceId: null,
		result: null,
		...overrides,
	};
}

const WORKSPACES: AdminBackups["workspaces"] = [
	{
		id: ALICE_WS,
		instance: ALICE_INSTANCE,
		label: "alice",
		ownerName: "Alice Smith",
		state: "running",
	},
	{
		id: BOB_WS,
		instance: BOB_INSTANCE,
		label: "bob",
		ownerName: "Bob Jones",
		state: "stopped",
	},
];

function backups(overrides: Partial<AdminBackups> = {}): AdminBackups {
	return {
		host: {
			vm: "portikus-vm",
			reportedAt: "2026-09-26T10:00:00.000Z",
			nextRunAt: "2026-09-27T02:30:00.000Z",
			lastRun: {
				startedAt: "2026-09-25T02:30:00.000Z",
				endedAt: "2026-09-25T02:40:00.000Z",
				result: "failed",
			},
			lastFailure: { at: "2026-09-25T02:40:00.000Z", reason: "the pool was busy" },
			running: null,
			keyInstalled: true,
			sets: [
				{
					stamp: FAILED,
					complete: false,
					sizeBytes: 1024,
					instances: [ALICE_INSTANCE],
					failedVolumes: [`${BOB_INSTANCE}-home`],
				},
				{
					stamp: NEW,
					complete: true,
					sizeBytes: 5 * 1024 ** 3,
					instances: [ALICE_INSTANCE, BOB_INSTANCE],
					failedVolumes: [],
					skippedVolumes: 2,
				},
				{
					stamp: OLD,
					complete: true,
					sizeBytes: 4 * 1024 ** 3,
					instances: [ALICE_INSTANCE, BOB_INSTANCE],
					failedVolumes: [],
				},
			],
			dumps: [
				{
					file: "portikus-pre-upgrade.dump",
					sizeBytes: 2048,
					modifiedAt: "2026-09-23T09:00:00.000Z",
				},
			],
		},
		hostReportedAt: new Date().toISOString(),
		hostStale: false,
		vm: {
			snapshots: [
				{
					volume: `${ALICE_INSTANCE}-home`,
					name: "pre-upgrade",
					createdAt: "2026-09-23T09:00:00.000Z",
				},
			],
			keptHomes: [
				{
					volume: `${ALICE_INSTANCE}-home-replaced-1790000000`,
					instance: ALICE_INSTANCE,
					createdAt: "2026-09-22T09:00:00.000Z",
				},
			],
		},
		vmListedAt: new Date().toISOString(),
		requests: [
			view({
				id: COPY_ID,
				kind: "restore_copy",
				args: { stamp: NEW, instance: ALICE_INSTANCE, dir: "restored-2026-09-24-0230" },
				workspaceId: ALICE_WS,
			}),
			view({
				id: "eeeeeeee-bbbb-4ccc-8ddd-eeeeeeeeeeee",
				kind: "delete_set",
				args: { stamp: OLD },
				state: "failed",
				error: "refused by the host: no such set",
			}),
		],
		workspaces: WORKSPACES,
		...overrides,
	};
}

/** Serves the Backups API and records every write. */
function stubBackups(
	data: AdminBackups,
	write: () => Response = () => json(202, view({})),
) {
	const writes: { method: string; url: string; body: unknown }[] = [];
	stubFetch((url, init) => {
		if (url === "/auth/me") return json(200, { ...USER, role: "administrator" });
		if (url === "/admin/backups" && (init?.method ?? "GET") === "GET") {
			return json(200, data);
		}
		if (url.startsWith("/admin/backups")) {
			writes.push({
				method: init?.method ?? "GET",
				url,
				body: init?.body ? JSON.parse(String(init.body)) : null,
			});
			return write();
		}
		return json(200, {});
	});
	return writes;
}

test("a stamp reads as its UTC time", () => {
	expect(stampIso(NEW)).toBe("2026-09-24T02:30:00Z");
});

test("the newest complete set is the one the host keeps", () => {
	expect(newestCompleteStamp(backups().host?.sets ?? [])).toBe(NEW);
	expect(newestCompleteStamp([])).toBeNull();
});

test("requests read in words, naming the workspace", () => {
	const copy = backups().requests[0] as BackupRequestView;
	expect(requestText(copy, WORKSPACES)).toMatch(
		/^Restore Alice Smith \(alice\) from .* into ~\/restored-2026-09-24-0230$/,
	);
	expect(requestText(view({ kind: "delete_dump", args: { file: "x.dump" } }), [])).toBe(
		"Delete dump x.dump",
	);
	expect(
		requestText(view({ kind: "delete_kept_home", args: { volume: "v" } }), []),
	).toBe("Delete kept home v");
	expect(
		requestText(
			view({ kind: "delete_snapshot", args: { volume: "v", snapshot: "pre-a" } }),
			[],
		),
	).toBe("Delete snapshot pre-a of v");
	expect(
		requestText(
			view({ kind: "import_home", args: { instance: BOB_INSTANCE } }),
			WORKSPACES,
		),
	).toBe("Import the home of Bob Jones (bob)");
	expect(workspaceName("ws-unknown", [])).toBe("ws-unknown");
	expect(stateText(view({ state: "pending" }))).toBe("Waiting for the host");
	expect(stateText(view({ state: "pending", kind: "delete_snapshot" }))).toBe(
		"Waiting for the platform",
	);
	expect(stateText(view({ state: "claimed" }))).toBe("Running");
	expect(stateText(view({ state: "failed" }))).toBe("Failed");
});

test("running now names the nightly run or the request", () => {
	const pending = view({ state: "pending" });
	expect(runningText(null, [], [])).toBe("Nothing");
	expect(runningText("nightly", [], [])).toBe("The nightly backup");
	expect(runningText(pending.id, [pending], [])).toBe("Back up now");
	expect(runningText("ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee", [], [])).toBe(
		"A requested job",
	);
	expect(waitingRequest([pending], "backup")).toBe(pending);
	expect(waitingRequest([pending], "delete_set")).toBeUndefined();
});

test("a site whose host never reported says backups are not connected", async () => {
	stubBackups(backups({ host: null, hostReportedAt: null, hostStale: true }));
	renderApp("/admin?tab=backups");
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
	renderApp("/admin?tab=backups");
	expect((await screen.findByRole("alert")).textContent).toBe(
		"Backups could not be loaded.",
	);
});

test("the status card shows the last run, failure, next run and key", async () => {
	stubBackups(backups());
	renderApp("/admin?tab=backups");
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
	renderApp("/admin?tab=backups");
	fireEvent.click(await screen.findByTestId("backup-run"));
	await waitFor(() =>
		expect(writes).toEqual([{ method: "POST", url: "/admin/backups/run", body: null }]),
	);
});

test("a stale host turns Back up now off and says why", async () => {
	const writes = stubBackups(
		backups({ hostStale: true, hostReportedAt: "2026-09-26T09:00:00.000Z" }),
	);
	renderApp("/admin?tab=backups");
	const run = await screen.findByTestId("backup-run");
	expect(run.getAttribute("aria-disabled")).toBe("true");
	expect(screen.getByTestId("backup-run-note").textContent).toBe(
		"Back up now waits until the host reports again.",
	);
	expect(screen.getByTestId("backups-host-stale").textContent).toContain(
		"The host has not reported since",
	);
	fireEvent.click(run);
	expect(writes).toEqual([]);
});

test("a running backup turns Back up now off", async () => {
	const data = backups();
	stubBackups({ ...data, host: data.host && { ...data.host, running: "nightly" } });
	renderApp("/admin?tab=backups");
	expect((await screen.findByTestId("backup-run")).getAttribute("aria-disabled")).toBe(
		"true",
	);
	expect(screen.getByTestId("backups-running").textContent).toBe("The nightly backup");
});

test("the newest complete set cannot be deleted; an older one can", async () => {
	const writes = stubBackups(backups());
	renderApp("/admin?tab=backups");
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
	renderApp("/admin?tab=backups");
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
	renderApp("/admin?tab=backups");
	const row = await screen.findByTestId(`backup-set-${OLD}`);
	const restore = within(row).getByTestId("backup-set-restore");
	expect(restore.getAttribute("aria-disabled")).toBe("true");
	const reason = document.getElementById(
		restore.getAttribute("aria-describedby") ?? "",
	);
	expect(reason?.textContent).toBe("No workspaces to restore from this set.");
});

test("restore picks a running workspace and names the folder", async () => {
	const writes = stubBackups(backups());
	renderApp("/admin?tab=backups");
	const row = await screen.findByTestId(`backup-set-${NEW}`);
	fireEvent.click(within(row).getByTestId("backup-set-restore"));
	const dialog = await screen.findByTestId("backup-restore-dialog");
	expect(within(dialog).getByTestId("backup-restore-folder").textContent).toBe(
		"~/restored-2026-09-24-0230",
	);
	const confirm = within(dialog).getByTestId("backup-restore-confirm");
	expect(confirm.getAttribute("aria-disabled")).toBe("true");
	expect(confirm.getAttribute("aria-describedby")).toBe("backup-restore-choose");
	expect(within(dialog).getByText("Choose a workspace to restore.")).toBeTruthy();
	// Mounted empty before any choice, so a later warning is announced.
	expect(within(dialog).getByRole("status").textContent).toBe("");

	fireEvent.click(within(dialog).getByLabelText("Workspace"));
	fireEvent.click(
		await screen.findByRole("option", { name: "Bob Jones (bob), stopped" }),
	);
	await waitFor(() =>
		expect(within(dialog).getByRole("status").textContent).toContain(
			"Start this workspace first.",
		),
	);
	fireEvent.click(confirm);
	expect(writes).toEqual([]);

	fireEvent.click(within(dialog).getByLabelText("Workspace"));
	fireEvent.click(await screen.findByRole("option", { name: "Alice Smith (alice)" }));
	await waitFor(() => expect(confirm.getAttribute("aria-disabled")).toBeNull());
	fireEvent.click(confirm);
	await waitFor(() =>
		expect(writes).toEqual([
			{
				method: "POST",
				url: "/admin/backups/restores",
				body: { stamp: NEW, workspaceId: ALICE_WS },
			},
		]),
	);
});

test("a refused restore keeps the dialog open with the reason", async () => {
	stubBackups(backups(), () =>
		json(409, { code: "WORKSPACE_NOT_RUNNING", message: "Start the workspace first" }),
	);
	renderApp("/admin?tab=backups");
	const row = await screen.findByTestId(`backup-set-${NEW}`);
	fireEvent.click(within(row).getByTestId("backup-set-restore"));
	const dialog = await screen.findByTestId("backup-restore-dialog");
	fireEvent.click(within(dialog).getByLabelText("Workspace"));
	fireEvent.click(await screen.findByRole("option", { name: "Alice Smith (alice)" }));
	fireEvent.click(within(dialog).getByTestId("backup-restore-confirm"));
	expect((await within(dialog).findByRole("alert")).textContent).toBe(
		"Start the workspace first",
	);
});

test("without the restore key, Restore is off and says why", async () => {
	const data = backups();
	stubBackups({ ...data, host: data.host && { ...data.host, keyInstalled: false } });
	renderApp("/admin?tab=backups");
	const row = await screen.findByTestId(`backup-set-${NEW}`);
	const restore = within(row).getByTestId("backup-set-restore");
	expect(restore.getAttribute("aria-disabled")).toBe("true");
	expect(restore.getAttribute("aria-describedby")).toBe("backups-key-note");
	fireEvent.click(restore);
	expect(screen.queryByTestId("backup-restore-dialog")).toBeNull();
});

test("replace home needs the workspace label typed", async () => {
	const writes = stubBackups(backups());
	renderApp("/admin?tab=backups");
	const copy = await screen.findByTestId("backup-copy");
	expect(copy.textContent).toContain("Copied");
	fireEvent.click(within(copy).getByTestId("backup-copy-replace"));
	const dialog = await screen.findByTestId("backup-replace-dialog");
	expect(dialog.textContent).toContain(
		"Each active project gets a recovery point first.",
	);
	const confirm = within(dialog).getByTestId("dialog-confirm") as HTMLButtonElement;
	expect(confirm.disabled).toBe(true);
	fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "alice" } });
	expect(confirm.disabled).toBe(false);
	fireEvent.click(confirm);
	await waitFor(() =>
		expect(writes).toEqual([
			{
				method: "POST",
				url: `/admin/backups/restores/${COPY_ID}/replace-home`,
				body: null,
			},
		]),
	);
});

test("a failed copy shows the host's reason and no Replace", async () => {
	const data = backups();
	stubBackups({
		...data,
		requests: [
			view({
				kind: "restore_copy",
				args: { stamp: NEW, instance: ALICE_INSTANCE, dir: "restored-2026-09-24-0230" },
				workspaceId: ALICE_WS,
				state: "failed",
				error: "~/restored-2026-09-24-0230 already exists.",
			}),
		],
	});
	renderApp("/admin?tab=backups");
	const copy = await screen.findByTestId("backup-copy");
	expect(copy.textContent).toContain("already exists");
	expect(within(copy).queryByTestId("backup-copy-replace")).toBeNull();
});

test("snapshots, dumps and kept homes each delete through their own route", async () => {
	const writes = stubBackups(backups());
	renderApp("/admin?tab=backups");
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
	renderApp("/admin?tab=backups");
	expect(await screen.findByText("No backup sets yet.")).toBeTruthy();
	expect(screen.getByText("No pre-change dumps.")).toBeTruthy();
	expect(screen.getAllByText("Not listed yet.")).toHaveLength(2);
	expect(screen.getByText("No workspaces restored recently.")).toBeTruthy();
	expect(screen.getByText("No requests yet.")).toBeTruthy();
});

test("a failed request shows its error in the recent list", async () => {
	stubBackups(backups());
	renderApp("/admin?tab=backups");
	const list = await screen.findByTestId("backup-requests");
	expect(list.textContent).toContain("refused by the host: no such set");
});
