import { expect, type Page, test } from "@playwright/test";
import { expectNoViolations, loginAs, openToggletip, routeApi } from "./helpers";
import { expectTokenFill } from "./token-colour";

/**
 * Automated accessibility checks (SPEC.md section 25.8) on the Backups tab
 * and each of its dialogs, in both themes (SPEC.md section 24.9). The page is
 * served a fixed status in the browser, because admin-backups.spec.ts owns
 * the channel's one status row and runs its tests in order against it.
 */

const NEW = "20260924T023000Z";
const OLD = "20260920T023000Z";
const WS_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const INSTANCE = `ws-${"a".repeat(24)}`;

const BACKUPS = {
	host: {
		vm: "portikus-e2e",
		reportedAt: "2026-09-27T10:00:00.000Z",
		nextRunAt: "2026-09-28T02:30:00.000Z",
		lastRun: {
			startedAt: "2026-09-27T02:30:00.000Z",
			endedAt: "2026-09-27T02:41:00.000Z",
			result: "failed",
		},
		lastFailure: { at: "2026-09-27T02:41:00.000Z", reason: "the pool was busy" },
		running: null,
		keyInstalled: true,
		sets: [
			{
				stamp: NEW,
				complete: true,
				sizeBytes: 5 * 1024 ** 3,
				instances: [INSTANCE],
				failedVolumes: [],
			},
			{
				stamp: OLD,
				complete: false,
				sizeBytes: 1024 ** 3,
				instances: [INSTANCE],
				failedVolumes: [`${INSTANCE}-docker`],
				verified: false,
			},
		],
		dumps: [
			{
				file: "portikus-pre-upgrade.dump",
				sizeBytes: 4096,
				modifiedAt: "2026-09-26T09:00:00.000Z",
			},
		],
	},
	hostReportedAt: "2026-09-27T09:00:00.000Z",
	hostStale: true,
	vm: {
		snapshots: [
			{
				volume: `${INSTANCE}-home`,
				name: "pre-upgrade",
				createdAt: "2026-09-26T09:00:00.000Z",
			},
		],
		keptHomes: [
			{
				volume: `${INSTANCE}-home-replaced-1790000000`,
				instance: INSTANCE,
				createdAt: "2026-09-25T09:00:00.000Z",
			},
		],
	},
	vmListedAt: "2026-09-27T10:00:00.000Z",
	requests: [
		{
			id: "cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee",
			kind: "restore_copy",
			args: { stamp: NEW, instance: INSTANCE, dir: "restored-2026-09-24-0230" },
			state: "done",
			requestedAt: "2026-09-27T09:00:00.000Z",
			claimedAt: "2026-09-27T09:00:10.000Z",
			finishedAt: "2026-09-27T09:02:00.000Z",
			error: null,
			workspaceId: WS_ID,
			result: null,
		},
		{
			id: "dddddddd-bbbb-4ccc-8ddd-eeeeeeeeeeee",
			kind: "delete_dump",
			args: { file: "portikus-pre-old.dump" },
			state: "failed",
			requestedAt: "2026-09-27T08:00:00.000Z",
			claimedAt: "2026-09-27T08:00:10.000Z",
			finishedAt: "2026-09-27T08:00:11.000Z",
			error: "refused by the host: no such dump",
			workspaceId: null,
			result: null,
		},
	],
	workspaces: [
		{
			id: WS_ID,
			instance: INSTANCE,
			label: "alice",
			ownerName: "Alice Smith",
			state: "running",
		},
	],
};

async function openTab(
	page: Page,
	colorScheme: "light" | "dark",
	json: unknown = BACKUPS,
) {
	await routeApi(page, "**/admin/backups", (route) =>
		route.request().method() === "GET" ? route.fulfill({ json }) : route.continue(),
	);
	await page.emulateMedia({ colorScheme });
	await loginAs(page, "carol");
	await page.goto("/admin/backups");
	await expect(page.getByTestId("backups-status")).toBeVisible();
}

for (const colorScheme of ["light", "dark"] as const) {
	test(`the Backups tab has no automatic accessibility violations (${colorScheme})`, async ({
		page,
	}) => {
		await openTab(page, colorScheme);
		await expect(page.getByTestId("backups-host-stale")).toBeVisible();
		// A warning fill, not a plain card.
		await expectTokenFill(
			page.getByTestId("backups-host-stale"),
			"--status-warning-soft",
		);
		await expectNoViolations(page);
		// The intro and an open toggletip, which Escape closes back onto its button.
		await expect(page.getByTestId("intro-admin-backups")).toBeVisible();
		const tip = page.getByRole("button", { name: "About the restore key" });
		await tip.click();
		await expect(openToggletip(page)).toBeVisible();
		await expectNoViolations(page);
		await page.keyboard.press("Escape");
		await expect(openToggletip(page)).toHaveCount(0);
		await expect(tip).toBeFocused();
	});

	test(`the Backups tab with nothing listed has no automatic accessibility violations (${colorScheme})`, async ({
		page,
	}) => {
		await openTab(page, colorScheme, {
			...BACKUPS,
			host: { ...BACKUPS.host, sets: [], dumps: [] },
			hostStale: false,
			vm: { snapshots: [], keptHomes: [] },
			requests: [],
		});
		await expect(page.getByText("No backup sets yet.")).toBeVisible();
		await expectNoViolations(page);
		// Clean up opens and closes from the keyboard.
		const summary = page.getByTestId("backups-cleanup-summary");
		await summary.focus();
		await page.keyboard.press("Enter");
		await expect(page.getByText("No pre-change dumps.")).toBeVisible();
		await expectNoViolations(page);
	});

	test(`the Backups dialogs have no automatic accessibility violations (${colorScheme})`, async ({
		page,
	}) => {
		await openTab(page, colorScheme);

		await page
			.getByTestId(`backup-set-${OLD}`)
			.getByTestId("backup-set-delete")
			.click();
		await expect(page.getByTestId("backup-delete-dialog")).toBeVisible();
		await expectNoViolations(page);
		await page.keyboard.press("Escape");
		await expect(page.getByTestId("backup-delete-dialog")).toHaveCount(0);

		await page
			.getByTestId(`backup-set-${NEW}`)
			.getByTestId("backup-set-restore")
			.click();
		const restore = page.getByTestId("backup-restore-dialog");
		await restore.getByLabel("Workspace").click();
		await page.getByRole("option", { name: "Alice Smith (alice)" }).click();
		await expectNoViolations(page);
		await page.keyboard.press("Escape");
		await expect(restore).toHaveCount(0);

		await page.getByTestId("backup-copy-replace").click();
		await expect(page.getByTestId("backup-replace-dialog")).toBeVisible();
		await expectNoViolations(page);
		await page.keyboard.press("Escape");
		await expect(page.getByTestId("backup-replace-dialog")).toHaveCount(0);
		// Focus goes back to the button that opened it.
		await expect(page.getByTestId("backup-copy-replace")).toBeFocused();
	});
}

/** Answers each per-item delete with a recorded request, or `refuse` for the paths it names. */
async function stubDeletes(
	page: Page,
	refuse: (path: string) => boolean = () => false,
) {
	const paths: string[] = [];
	await routeApi(
		page,
		"**/admin/backups/{sets,dumps,snapshots,kept-homes}/**",
		(route) => {
			if (route.request().method() !== "DELETE") return route.fallback();
			const path = decodeURIComponent(new URL(route.request().url()).pathname);
			paths.push(path);
			return refuse(path)
				? route.fulfill({
						status: 409,
						json: {
							code: "BACKUP_RUNNING",
							message: "A backup is running. Try after it ends.",
						},
					})
				: route.fulfill({
						status: 202,
						json: {
							...BACKUPS.requests[1],
							state: "pending",
							error: null,
							finishedAt: null,
						},
					});
		},
	);
	return paths;
}

for (const colorScheme of ["light", "dark"] as const) {
	test(`rows are ticked and deleted with the keyboard alone (${colorScheme})`, async ({
		page,
	}) => {
		const paths = await stubDeletes(page);
		await openTab(page, colorScheme);

		// Each list's select-all box follows its heading's help button.
		await page.getByRole("button", { name: "About pre-change snapshots" }).focus();
		await page.keyboard.press("Tab");
		const snapshots = page.getByRole("checkbox", {
			name: "Select all pre-change snapshots",
		});
		await expect(snapshots).toBeFocused();
		await page.keyboard.press("Space");
		await expect(snapshots).toBeChecked();
		await expect(page.getByTestId("backup-selected-count")).toHaveText("1 selected");

		await page.getByRole("button", { name: "About pre-change database dumps" }).focus();
		await page.keyboard.press("Tab");
		const dump = page.getByRole("checkbox", {
			name: "Select all pre-change database dumps",
		});
		await expect(dump).toBeFocused();
		await page.keyboard.press("Space");
		await expect(page.getByTestId("backup-selected-count")).toHaveText("2 selected");

		// The list's Delete selected button sits between its heading and its table.
		await page.keyboard.press("Shift+Tab");
		const button = page.getByTestId("backups-dumps-title-delete-selected");
		await expect(button).toBeFocused();
		await expect(button).toHaveText("Delete 2 selected…");
		await expectNoViolations(page);
		await page.keyboard.press("Enter");

		const dialog = page.getByTestId("backup-delete-dialog");
		await expect(dialog.getByRole("heading")).toHaveText("Delete 2 items?");
		await expect(dialog).toContainText("1 snapshot and 1 database dump.");
		await expectNoViolations(page);
		const confirm = dialog.getByTestId("dialog-confirm");
		for (let tries = 0; tries < 3; tries += 1) {
			if (await confirm.evaluate((el) => el === document.activeElement)) break;
			await page.keyboard.press("Tab");
		}
		await expect(confirm).toBeFocused();
		await page.keyboard.press("Enter");

		await expect(dialog).toHaveCount(0);
		expect(paths).toEqual([
			`/admin/backups/snapshots/${INSTANCE}-home/pre-upgrade`,
			"/admin/backups/dumps/portikus-pre-upgrade.dump",
		]);
		// The result is read out, and focus lands on the heading of the list it came from.
		const done = page
			.locator(".pk-toast")
			.filter({ hasText: "Delete requested for 1 snapshot and 1 database dump" });
		await expect(done.getByRole("status")).toHaveCount(1);
		await expect(
			page.getByRole("heading", { level: 4, name: "Pre-change database dumps" }),
		).toBeFocused();
		await expect(page.getByTestId("backup-selected-count")).toHaveText("");
	});

	test(`a delete that partly failed has no automatic accessibility violations (${colorScheme})`, async ({
		page,
	}) => {
		await stubDeletes(page, (path) => path.includes("/kept-homes/"));
		await openTab(page, colorScheme);
		await page.getByRole("checkbox", { name: "Select all kept homes" }).check();
		await page
			.getByRole("checkbox", { name: "Select all pre-change snapshots" })
			.check();
		await page.getByTestId("backups-kept-title-delete-selected").click();
		const dialog = page.getByTestId("backup-delete-dialog");
		await expect(dialog.getByRole("heading")).toHaveText("Delete 2 items?");
		await dialog.getByTestId("dialog-confirm").click();
		await expect(dialog.getByRole("alert")).toContainText(
			"Delete requested for 1 snapshot. This was not deleted:",
		);
		await expect(dialog.getByRole("alert")).toContainText(
			"The kept home of Alice Smith (alice): A backup is running. Try after it ends.",
		);
		await expectNoViolations(page);
		await page.keyboard.press("Escape");
		await expect(dialog).toHaveCount(0);
		// What failed is still ticked, so its button is still there to take focus back.
		await expect(page.getByTestId("backups-kept-title-delete-selected")).toBeFocused();
		await expect(
			page.getByRole("checkbox", { name: "Select all kept homes" }),
		).toBeChecked();
	});
}

test("focus inside Activity lands on the Restores heading when the first request arrives", async ({
	page,
}) => {
	let json: unknown = { ...BACKUPS, hostStale: false, requests: [] };
	await routeApi(page, "**/admin/backups", (route) =>
		route.request().method() === "GET" ? route.fulfill({ json }) : route.continue(),
	);
	await loginAs(page, "carol");
	await page.goto("/admin/backups");
	const help = page
		.getByTestId("backups-activity")
		.getByRole("button", { name: "About Replace home" });
	await help.focus();
	await expect(help).toBeFocused();

	// The next poll brings the first request, which splits Activity into two cards.
	json = { ...BACKUPS, hostStale: false };
	await expect(page.getByTestId("backups-restores")).toBeVisible({ timeout: 15_000 });
	await expect(page.getByTestId("backups-activity")).toHaveCount(0);
	await expect(page.getByRole("heading", { level: 3, name: "Restores" })).toBeFocused();
});
