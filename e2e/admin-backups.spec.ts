import { expect, type Page, test } from "@playwright/test";
import {
	backupSet,
	hostPull,
	hostReport,
	hostStatus,
	resetBackups,
	setVmListing,
} from "./backup-channel";
import {
	createStudent,
	loginAs,
	query,
	settledAxe,
	toast,
	WCAG_TAGS,
	WEB_ORIGIN,
} from "./helpers";

/**
 * The admin Backups tab (SPEC.md §20.1, §24.9; ADR 0024, ADR 0040), with the
 * host's side played through the real `backup-channel` pull and report. The
 * channel has one status row and one queue, so these tests run in order.
 */
test.describe.configure({ mode: "serial" });

const OLD = "20260920T023000Z";
const NEW = "20260924T023000Z";
/** The host reports every 30 seconds; the page polls every 5. */
const SOON = { timeout: 15_000 };

async function student(page: Page) {
	const context = await page.context().browser()?.newContext({ baseURL: WEB_ORIGIN });
	if (!context) throw new Error("no browser");
	const made = await createStudent(context);
	await context.close();
	const [row] = await query<{ label: string; incus_instance_name: string }>(
		"select label, incus_instance_name from workspaces where id = $1",
		[made.workspaceId],
	);
	if (!row) throw new Error("no workspace");
	return { ...made, label: row.label, instance: row.incus_instance_name };
}

async function openTab(page: Page) {
	await loginAs(page, "carol");
	await page.goto("/admin/backups");
	await expect(page.getByRole("heading", { name: "Backups", level: 2 })).toBeVisible();
}

test.beforeEach(async () => {
	await resetBackups();
});

test("a site whose host never reported says backups are not connected", async ({
	page,
}) => {
	await openTab(page);
	await expect(page.getByText("Backups are not connected on this site")).toBeVisible();
	await expect(page.getByTestId("backup-run")).toHaveCount(0);
});

test("the status card shows a fresh host, and a stale one turns Back up now off", async ({
	page,
}) => {
	hostReport(
		hostStatus({
			lastRun: {
				startedAt: "2026-09-27T02:30:00.000Z",
				endedAt: "2026-09-27T02:31:00.000Z",
				result: "failed",
			},
			lastFailure: { at: "2026-09-27T02:31:00.000Z", reason: "the pool was busy" },
			keyInstalled: false,
		}),
	);
	await openTab(page);
	await expect(page.getByTestId("backups-host")).toHaveText(/^Reporting/);
	await expect(page.getByTestId("backups-last-run")).toHaveText(/^Failed/);
	await expect(page.getByTestId("backups-last-failure")).toContainText(
		"the pool was busy",
	);
	await expect(page.getByTestId("backups-key")).toHaveText(/^Not installed/);
	await expect(page.getByTestId("backup-run")).not.toHaveAttribute("aria-disabled");

	await query(
		"update backup_status set host_reported_at = now() - interval '10 minutes' where id = 1",
	);
	await expect(page.getByTestId("backups-host-stale")).toContainText(
		"The host has not reported since",
		SOON,
	);
	await expect(page.getByTestId("backup-run")).toHaveAttribute("aria-disabled", "true");
	await expect(page.getByTestId("backup-run-note")).toHaveText(
		"Back up now waits until the host reports again.",
	);
});

test("Back up now goes through the host and the new set appears", async ({ page }) => {
	const ws = await student(page);
	hostReport(hostStatus({ sets: [backupSet(OLD, [ws.instance])] }));
	await openTab(page);
	await page.getByTestId("backup-run").click();
	await expect(toast(page, "Backup requested")).toBeVisible();
	await expect(page.getByTestId("backup-run")).toHaveAttribute("aria-disabled", "true");

	const claimed = hostPull();
	expect(claimed?.kind).toBe("backup");
	hostReport(
		hostStatus({
			running: claimed?.id ?? null,
			sets: [backupSet(OLD, [ws.instance])],
		}),
	);
	await expect(page.getByTestId("backups-running")).toHaveText("Back up now", SOON);

	hostReport(
		hostStatus({
			sets: [backupSet(NEW, [ws.instance]), backupSet(OLD, [ws.instance])],
		}),
		{ id: claimed?.id as string, state: "done", error: null, stamp: NEW },
	);
	await expect(page.getByTestId(`backup-set-${NEW}`)).toBeVisible(SOON);
	await expect(page.getByTestId("backup-request").first()).toContainText("Done");
	await expect(page.getByTestId("backup-run")).not.toHaveAttribute("aria-disabled");
});

test("an old set is deleted by the host; the newest complete set is refused", async ({
	page,
}) => {
	const ws = await student(page);
	hostReport(
		hostStatus({
			sets: [backupSet(NEW, [ws.instance]), backupSet(OLD, [ws.instance])],
		}),
	);
	await openTab(page);

	const newest = page.getByTestId(`backup-set-${NEW}`);
	await expect(newest).toContainText("The newest complete set is always kept.");
	await expect(newest.getByTestId("backup-set-delete")).toHaveAttribute(
		"aria-disabled",
		"true",
	);
	await newest.getByTestId("backup-set-delete").click({ force: true });
	await expect(page.getByTestId("backup-delete-dialog")).toHaveCount(0);
	// The API refuses it too, whatever the page shows.
	const refused = await page.request.delete(`/admin/backups/sets/${NEW}`, {
		headers: { origin: WEB_ORIGIN },
	});
	expect(refused.status()).toBe(409);
	expect((await refused.json()).code).toBe("BACKUP_NEWEST_SET");

	await page.getByTestId(`backup-set-${OLD}`).getByTestId("backup-set-delete").click();
	const dialog = page.getByTestId("backup-delete-dialog");
	await expect(dialog).toContainText("Workspaces can no longer be restored from it.");
	await dialog.getByTestId("dialog-confirm").click();
	await expect(toast(page, "Delete requested")).toBeVisible();
	await expect(page.getByTestId(`backup-set-${OLD}`)).toContainText("Deleting…");
	// The button stays mounted while the host works, so focus returns to it.
	const deleting = page
		.getByTestId(`backup-set-${OLD}`)
		.getByTestId("backup-set-delete");
	await expect(deleting).toHaveText("Deleting…");
	await expect(deleting).toHaveAttribute("aria-disabled", "true");
	await expect(deleting).toBeFocused();

	const claimed = hostPull();
	expect(claimed).toMatchObject({ kind: "delete_set", args: { stamp: OLD } });
	hostReport(hostStatus({ sets: [backupSet(NEW, [ws.instance])] }), {
		id: claimed?.id as string,
		state: "done",
		error: null,
		stamp: null,
	});
	await expect(page.getByTestId(`backup-set-${OLD}`)).toHaveCount(0, SOON);
	// The row took the focused button with it, so focus lands on the list heading.
	await expect(page.getByRole("heading", { name: "Backup sets" })).toBeFocused();
});

test("empty lists are one line each, and Clean up stays closed until there is something to delete", async ({
	page,
}) => {
	hostReport(hostStatus({}));
	await page.setViewportSize({ width: 1440, height: 900 });
	await openTab(page);
	await expect(page.getByTestId("backups-status")).toBeVisible();
	// No table is drawn just for its headers.
	await expect(page.getByText("No backup sets yet.")).toBeVisible();
	await expect(page.getByText("No workspaces restored recently.")).toBeVisible();
	await expect(page.getByRole("table")).toHaveCount(0);

	const summary = page.getByTestId("backups-cleanup-summary");
	await expect(summary).toHaveText(/^Clean up: /);
	await expect(page.getByText("No pre-change dumps.")).toBeHidden();
	await summary.click();
	await expect(page.getByText("No pre-change dumps.")).toBeVisible();

	// At this width the status pairs sit two to a row.
	const host = await page.getByTestId("backups-host").boundingBox();
	const running = await page.getByTestId("backups-running").boundingBox();
	expect(running?.y).toBe(host?.y);
	expect(running?.x).toBeGreaterThan((host?.x ?? 0) + (host?.width ?? 0));
});

test("a set the host could not verify is marked and cannot be restored", async ({
	page,
}) => {
	const instance = `ws-${"a".repeat(24)}`;
	hostReport(
		hostStatus({
			sets: [
				backupSet(NEW, [instance], { verified: false }),
				backupSet(OLD, [instance], { verified: true }),
			],
		}),
	);
	await openTab(page);
	const forged = page.getByTestId(`backup-set-${NEW}`);
	await expect(forged).toContainText(
		"Not verified. This server's key did not make this set, so it cannot be restored.",
	);
	const restore = forged.getByTestId("backup-set-restore");
	await expect(restore).toHaveAttribute("aria-disabled", "true");
	await expect(restore).toHaveAccessibleDescription(/cannot be restored/);
	await restore.dispatchEvent("click");
	await expect(page.getByTestId("backup-restore-dialog")).toHaveCount(0);
	const genuine = page.getByTestId(`backup-set-${OLD}`);
	await expect(genuine).not.toContainText("Not verified");
	await expect(genuine.getByTestId("backup-set-restore")).not.toHaveAttribute(
		"aria-disabled",
	);
});

test("a refusal from the host is shown with its reason", async ({ page }) => {
	hostReport(
		hostStatus({
			dumps: [
				{
					file: "portikus-pre-upgrade.dump",
					sizeBytes: 4096,
					modifiedAt: "2026-09-26T09:00:00.000Z",
				},
			],
		}),
	);
	await openTab(page);
	await page.getByTestId("backup-dump-delete").click();
	await page.getByTestId("backup-delete-dialog").getByTestId("dialog-confirm").click();
	await expect(page.getByTestId("backup-dump")).toContainText("Deleting…");

	const claimed = hostPull();
	expect(claimed).toMatchObject({
		kind: "delete_dump",
		args: { file: "portikus-pre-upgrade.dump" },
	});
	hostReport(hostStatus({ dumps: [] }), {
		id: claimed?.id as string,
		state: "failed",
		error: "refused by the host: no such dump",
		stamp: null,
	});
	await expect(page.getByTestId("backup-requests")).toContainText(
		"refused by the host: no such dump",
		SOON,
	);
	await expect(page.getByText("No pre-change dumps.")).toBeVisible();
});

test("restore into a side copy, then replace home with a typed confirmation", async ({
	page,
}) => {
	const ws = await student(page);
	const stopped = await student(page);
	await query("update workspaces set state = 'stopped' where id = $1", [
		stopped.workspaceId,
	]);
	hostReport(hostStatus({ sets: [backupSet(NEW, [ws.instance, stopped.instance])] }));
	await openTab(page);

	await page.getByTestId(`backup-set-${NEW}`).getByTestId("backup-set-restore").click();
	const dialog = page.getByTestId("backup-restore-dialog");
	await expect(dialog.getByTestId("backup-restore-folder")).toHaveText(
		"~/restored-2026-09-24-0230",
	);
	await dialog.getByLabel("Workspace").click();
	await page
		.getByRole("option", { name: `E2E Student (${stopped.label}), stopped` })
		.click();
	await expect(dialog.locator("#backup-restore-stopped")).toContainText(
		"Start this workspace first.",
	);
	// The always-mounted status region carries the same words for screen readers.
	await expect(
		dialog.getByRole("status").filter({ hasText: "Start this workspace first." }),
	).toHaveCount(1);
	await expect(dialog.getByTestId("backup-restore-confirm")).toHaveAttribute(
		"aria-disabled",
		"true",
	);

	await dialog.getByLabel("Workspace").click();
	await page.getByRole("option", { name: `E2E Student (${ws.label})` }).click();
	await dialog.getByTestId("backup-restore-confirm").click();
	await expect(toast(page, "Restore requested")).toBeVisible();
	await expect(dialog).toHaveCount(0);
	const copy = page.getByTestId("backup-copy");
	await expect(copy).toContainText("Waiting for the host");

	const claimed = hostPull();
	expect(claimed).toMatchObject({
		kind: "restore_copy",
		args: { stamp: NEW, instance: ws.instance, dir: "restored-2026-09-24-0230" },
	});
	await expect(copy).toContainText("Copying", SOON);
	hostReport(hostStatus({ sets: [backupSet(NEW, [ws.instance, stopped.instance])] }), {
		id: claimed?.id as string,
		state: "done",
		error: null,
		stamp: null,
	});
	await expect(copy).toContainText("Copied", SOON);
	const [notice] = await query<{ body: string }>(
		"select body from notifications where user_id = $1",
		[ws.userId],
	);
	expect(notice?.body).toContain("into ~/restored-2026-09-24-0230");

	await copy.getByTestId("backup-copy-replace").click();
	const replace = page.getByTestId("backup-replace-dialog");
	await expect(replace).toContainText(
		"Each active project gets a recovery point first.",
	);
	await expect(replace).toContainText("The current home folder is kept");
	const confirm = replace.getByTestId("dialog-confirm");
	await expect(confirm).toBeDisabled();
	await replace.getByRole("textbox").fill("not-the-label");
	await expect(confirm).toBeDisabled();
	await replace.getByRole("textbox").fill(ws.label);
	await confirm.click();
	await expect(toast(page, "Home replace requested")).toBeVisible();
	const [row] = await query<{ pending_operation: string | null }>(
		"select pending_operation from workspaces where id = $1",
		[ws.workspaceId],
	);
	expect(row?.pending_operation).toBe("replace-home");
});

test("pre-change snapshots and kept homes are deleted through the platform", async ({
	page,
}) => {
	const ws = await student(page);
	hostReport(hostStatus({ sets: [backupSet(NEW, [ws.instance])] }));
	await setVmListing({
		snapshots: [
			{
				volume: `${ws.instance}-home`,
				name: "pre-upgrade",
				createdAt: "2026-09-26T09:00:00.000Z",
			},
		],
		keptHomes: [
			{
				volume: `${ws.instance}-home-replaced-1790000000`,
				instance: ws.instance,
				createdAt: "2026-09-25T09:00:00.000Z",
			},
		],
	});
	await openTab(page);

	await page.getByTestId("backup-snapshot-delete").click();
	await page.getByTestId("backup-delete-dialog").getByTestId("dialog-confirm").click();
	await expect(page.getByTestId("backup-snapshot")).toContainText("Deleting…");

	await page.getByTestId("backup-kept-home-delete").click();
	const dialog = page.getByTestId("backup-delete-dialog");
	await expect(dialog).toContainText("Once deleted it cannot be put back.");
	await dialog.getByTestId("dialog-confirm").click();
	await expect(page.getByTestId("backup-kept-home")).toContainText("Deleting…");

	const rows = await query<{ kind: string; args: Record<string, string> }>(
		"select kind, args from backup_requests order by requested_at",
	);
	expect(rows).toEqual([
		{
			kind: "delete_snapshot",
			args: { volume: `${ws.instance}-home`, snapshot: "pre-upgrade" },
		},
		{
			kind: "delete_kept_home",
			args: { volume: `${ws.instance}-home-replaced-1790000000` },
		},
	]);
	// These are VM work for the worker; the host is never handed them.
	expect(hostPull()).toBeNull();
});

for (const colorScheme of ["light", "dark"] as const) {
	test(`with backups not connected, Restore from backup in a panel says only that (${colorScheme})`, async ({
		page,
	}) => {
		const ws = await student(page);
		const [owner] = await query<{ display_name: string }>(
			"select display_name from users where id = $1",
			[ws.userId],
		);
		// No host has reported (the beforeEach reset), so the API sends host: null.
		await page.emulateMedia({ colorScheme });
		await loginAs(page, "carol");
		await page.goto(`/admin/users?user=${ws.userId}`);
		const panel = page.getByTestId("workspace-detail");
		await panel
			.getByRole("button", {
				name: `Restore from backup: ${owner?.display_name}'s workspace`,
			})
			.click({ timeout: 15_000 });
		const dialog = page.getByRole("dialog", { name: "Restore from backup" });
		await expect(dialog.getByTestId("backup-restore-none")).toHaveText(
			"Backups are not connected on this site.",
		);
		await expect(dialog).not.toContainText("No backup set holds this workspace yet.");
		await expect(dialog.getByTestId("backup-restore-folder")).toHaveCount(0);
		await expect(dialog.getByTestId("backup-restore-confirm")).toHaveAttribute(
			"aria-disabled",
			"true",
		);
		const results = await (await settledAxe(page)).withTags(WCAG_TAGS).analyze();
		expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
	});
}
