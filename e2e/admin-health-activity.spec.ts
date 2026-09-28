import { randomUUID } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import { createStudent, loginAs, query, settledAxe } from "./helpers";

/**
 * The Health tab's per-workspace heat map and the guard and activity charts
 * (SPEC.md §25.6, #598 items 3 to 5). No worker runs in e2e, so the tests
 * write the usage samples and audit rows the worker and API would.
 */
test.describe.configure({ mode: "serial" });

const GIB = 1024 ** 3;
/** This worker's own audit rows, so another copy of this file never deletes them. */
const TARGET = `e2e-activity-${randomUUID()}`;

async function seedUsage(
	workspaceId: string,
	minutesAgo: number,
	cpuSeconds: number,
	memoryGiB: number,
): Promise<void> {
	await query(
		`insert into workspace_usage_samples
		   (workspace_id, observed_at, cpu_usage_ns, boot_marker, cpu_limit,
		    memory_bytes, memory_limit_bytes)
		 values ($1, now() - make_interval(mins => $2), $3, 7, 2, $4, $5)`,
		[workspaceId, minutesAgo, cpuSeconds * 1e9, memoryGiB * GIB, 4 * GIB],
	);
}

async function seedAudit(
	action: string,
	minutesAgo: number,
	result = "ok",
): Promise<void> {
	await query(
		`insert into audit_events (actor, target, action, result, at)
		 values ('e2e', $4, $1, $2, now() - make_interval(mins => $3))`,
		[action, result, minutesAgo, TARGET],
	);
}

/**
 * The guard-event totals the one-day chart should show: every row in the API's
 * window (the current 15-minute bucket's end, back one day), ours and any
 * other spec's, since guard specs lift throttles while this one runs.
 */
async function guardTotals(): Promise<string> {
	const [row] = await query<{
		throttles: number;
		memory_flags: number;
		idle_stops: number;
		lifts: number;
	}>(
		`with w as (select to_timestamp((floor(extract(epoch from now()) / 900) + 1) * 900) as t)
		 select
		   count(*) filter (where action = 'workspace.cpu_throttled')::int as throttles,
		   count(*) filter (where action = 'workspace.memory_flagged')::int as memory_flags,
		   count(*) filter (where action = 'workspace.idle_stopped')::int as idle_stops,
		   count(*) filter (where action in
		     ('workspace.cpu_throttle_lifted', 'workspace.memory_flag_cleared'))::int as lifts
		 from audit_events, w
		 where at >= w.t - interval '1 day' and at < w.t`,
	);
	if (!row) throw new Error("no totals");
	// Our own rows are always part of it.
	expect(row.throttles).toBeGreaterThanOrEqual(2);
	expect(row.memory_flags).toBeGreaterThanOrEqual(1);
	expect(row.idle_stops).toBeGreaterThanOrEqual(1);
	expect(row.lifts).toBeGreaterThanOrEqual(1);
	return `Total in this range: throttles ${row.throttles}, memory flags ${row.memory_flags}, idle stops ${row.idle_stops}, lifts ${row.lifts}.`;
}

async function openHealth(page: Page, range: "1 hour" | "1 day"): Promise<void> {
	await loginAs(page, "carol");
	await page.goto("/admin?tab=health");
	await expect(page.getByTestId("health-trends")).toBeVisible({ timeout: 15_000 });
	await page.getByRole("button", { name: range, exact: true }).click();
	await expect(page.getByRole("button", { name: range, exact: true })).toHaveAttribute(
		"aria-pressed",
		"true",
	);
}

test.describe("admin health activity", () => {
	test.beforeEach(async () => {
		await query("delete from audit_events where target = $1", [TARGET]);
	});

	test.afterAll(async () => {
		await query("delete from audit_events where target = $1", [TARGET]);
	});

	test("the heat map reads each workspace, flags the threshold and links to the detail panel", async ({
		page,
		browser,
	}) => {
		const context = await browser.newContext();
		const student = await createStudent(context);
		await context.close();
		const name = `Heat ${student.userId.slice(0, 8)}`;
		await query("update users set display_name = $2 where id = $1", [
			student.userId,
			name,
		]);
		// 6 s then 108 s of CPU a minute on 2 CPUs: 5%, then 90%, over the 80% default.
		await seedUsage(student.workspaceId, 3, 0, 1);
		await seedUsage(student.workspaceId, 2, 6, 1);
		await seedUsage(student.workspaceId, 1, 114, 3);

		await openHealth(page, "1 hour");

		const map = page.getByTestId("health-heat-map");
		const row = map.getByTestId("health-heat-map-row").filter({ hasText: name });
		await expect(row).toBeVisible();
		await expect(row.getByRole("cell", { name: "5%", exact: true })).toHaveCount(1);
		const over = row.getByRole("cell", { name: "90%, at or over the 80% threshold" });
		await expect(over).toHaveCount(1);
		await expect(over.locator("div")).toHaveAttribute("data-over", "true");
		await expect(map.getByTestId("health-heat-map-retention")).toHaveCount(0);

		await map.getByRole("button", { name: "Memory" }).click();
		await expect(map.getByRole("button", { name: "Memory" })).toHaveAttribute(
			"aria-pressed",
			"true",
		);
		await expect(row.getByRole("cell", { name: "75%", exact: true })).not.toHaveCount(
			0,
		);

		const results = await (await settledAxe(page))
			.include('[data-testid="health-heat-map"]')
			.analyze();
		expect(results.violations).toEqual([]);

		await row.getByRole("link", { name }).click();
		await expect(page).toHaveURL(new RegExp(`tab=workspaces.*user=${student.userId}`));
		await expect(page.getByTestId("workspace-detail")).toBeVisible();

		await query("delete from workspace_usage_samples where workspace_id = $1", [
			student.workspaceId,
		]);
	});

	test("at one day the heat map says how long figures are kept, and the event charts total their counts", async ({
		page,
	}) => {
		test.setTimeout(60_000);
		await seedAudit("workspace.cpu_throttled", 30);
		await seedAudit("workspace.cpu_throttled", 90);
		await seedAudit("workspace.memory_flagged", 30);
		await seedAudit("workspace.idle_stopped", 120);
		await seedAudit("workspace.cpu_throttle_lifted", 60);
		await seedAudit("workspace.start_requested", 30);
		await seedAudit("workspace.stop_requested", 45);

		// Guard specs running alongside add lifts, so the page is read again until it
		// matches the database; our seeded rows are always part of the count.
		await expect(async () => {
			await openHealth(page, "1 day");
			const summary = page.getByTestId("health-chart-guard-events-summary");
			await expect(summary).toHaveText(/^Total in this range:/);
			const shown = await summary.textContent();
			expect(shown).toBe(await guardTotals());
		}).toPass({ timeout: 40_000 });

		await expect(page.getByTestId("health-heat-map-retention")).toHaveText(
			"Per-workspace figures are kept for about 4 hours.",
		);
		const activity = page.getByTestId("health-chart-activity");
		await expect(activity.locator("figcaption")).toHaveText(
			"Workspace starts, stops and sign-ins per 15 minutes",
		);
		// Other specs start, stop and sign in at the same time, so only the form is fixed.
		await expect(page.getByTestId("health-chart-activity-summary")).toHaveText(
			/^Total in this range: starts [1-9]\d*, stops [1-9]\d*, sign-ins [1-9]\d*\.$/,
		);

		const plot = page.getByTestId("health-chart-guard-events-plot");
		await plot.focus();
		await page.keyboard.press("End");
		// Only this spec writes throttles, and its rows are at least 30 minutes old.
		await expect(page.getByTestId("health-chart-guard-events-readout")).toContainText(
			"Throttles 0",
		);
	});
});
