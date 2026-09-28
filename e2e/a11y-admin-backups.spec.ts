import { expect, type Page, test } from "@playwright/test";
import { loginAs, settledAxe, WCAG_TAGS } from "./helpers";

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
	await page.route("**/admin/backups", (route) =>
		route.request().method() === "GET" ? route.fulfill({ json }) : route.continue(),
	);
	await page.emulateMedia({ colorScheme });
	await loginAs(page, "carol");
	await page.goto("/admin?tab=backups");
	await expect(page.getByTestId("backups-status")).toBeVisible();
}

async function expectNoViolations(page: Page) {
	const results = await (await settledAxe(page)).withTags(WCAG_TAGS).analyze();
	expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
}

for (const colorScheme of ["light", "dark"] as const) {
	test(`the Backups tab has no automatic accessibility violations (${colorScheme})`, async ({
		page,
	}) => {
		await openTab(page, colorScheme);
		await expect(page.getByTestId("backups-host-stale")).toBeVisible();
		await expectNoViolations(page);
		// The intro and an open toggletip, which Escape closes back onto its button.
		await expect(page.getByTestId("intro-admin-backups")).toBeVisible();
		const tip = page.getByRole("button", { name: "About the restore key" });
		await tip.click();
		await expect(page.getByRole("dialog", { name: "the restore key" })).toBeVisible();
		await expectNoViolations(page);
		await page.keyboard.press("Escape");
		await expect(page.getByRole("dialog", { name: "the restore key" })).toHaveCount(0);
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
