/**
 * The throttle hold (SPEC.md §19.4): the two settings, the Held tag on the
 * Workspaces and Health tabs, and the student's words for a throttle a
 * restart does not lift. The worker does not run here, so each test writes
 * the held throttle row the worker would.
 */
import { type Browser, expect, type Page, test } from "@playwright/test";
import {
	createStudent,
	loginAs,
	query,
	settledAxe,
	toast,
	workspacePath,
} from "./helpers";

async function expectNoViolations(page: Page) {
	const results = await (await settledAxe(page))
		.withTags(["wcag2a", "wcag2aa", "wcag21aa"])
		.analyze();
	expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
}

async function holdThrottle(workspaceId: string): Promise<void> {
	await query(
		"update workspaces set cpu_throttle = $2, updated_at = now() where id = $1",
		[
			workspaceId,
			JSON.stringify({
				at: new Date().toISOString(),
				averagePercent: 97,
				thresholdPercent: 80,
				windowMinutes: 30,
				sharePercent: 25,
				allowance: "100ms/100ms",
				held: { count: 3, hours: 24 },
			}),
		],
	);
}

async function heldStudent(browser: Browser) {
	const context = await browser.newContext();
	const student = await createStudent(context);
	await context.close();
	const name = `Held ${student.userId.slice(0, 8)}`;
	await query("update users set display_name = $2 where id = $1", [
		student.userId,
		name,
	]);
	await holdThrottle(student.workspaceId);
	return { ...student, name };
}

test("an administrator changes the hold settings, and a bad value is named", async ({
	page,
}) => {
	await loginAs(page, "carol");
	await page.goto("/admin?tab=settings");
	const after = page.getByLabel("Hold after throttles");
	const hours = page.getByLabel("Hold window (hours)");
	await expect(after).toHaveValue("3", { timeout: 15_000 });
	await expect(hours).toHaveValue("24");

	await hours.fill("200");
	await page.getByTestId("guard-settings-save").click();
	await expect(page.getByRole("alert")).toHaveText(
		"Enter a whole number from 1 to 168.",
	);
	await expectNoViolations(page);

	try {
		await after.fill("4");
		await hours.fill("48");
		await page.getByTestId("guard-settings-save").click();
		await expect(toast(page, "Resource guard saved")).toBeVisible();
		const [row] = await query<{ after: number; hours: number }>(
			"select cpu_throttle_hold_after as after, cpu_throttle_hold_hours as hours from settings where id = 1",
		);
		expect(row).toEqual({ after: 4, hours: 48 });
		await page.reload();
		await expect(page.getByLabel("Hold after throttles")).toHaveValue("4", {
			timeout: 15_000,
		});
	} finally {
		await query(
			"update settings set cpu_throttle_hold_after = 3, cpu_throttle_hold_hours = 24 where id = 1",
		);
	}
});

test("a held throttle shows Held on the Workspaces and Health tabs", async ({
	page,
	browser,
}) => {
	const student = await heldStudent(browser);
	await loginAs(page, "carol");
	await page.goto("/admin");
	await expect(page.getByTestId("admin-accounts")).toBeVisible({ timeout: 15_000 });
	await page.getByTestId("admin-filter-text").fill(student.name);
	const row = page.getByTestId(`account-row-${student.userId}`);
	await expect(row.getByText("Throttled", { exact: true })).toBeVisible();
	await expect(row.getByText("Held", { exact: true })).toBeVisible();

	await page.goto("/admin?tab=health");
	const list = page.getByTestId("health-guard");
	await expect(list).toBeVisible({ timeout: 15_000 });
	const healthRow = list.getByRole("row").filter({ hasText: student.name });
	await expect(healthRow.getByText("Throttled", { exact: true })).toBeVisible();
	await expect(healthRow.getByText("Held", { exact: true })).toBeVisible();
	await expectNoViolations(page);
});

for (const scheme of ["light", "dark"] as const) {
	test(`the student is told a restart keeps the throttle, and why (${scheme})`, async ({
		page,
		context,
	}) => {
		await page.emulateMedia({ colorScheme: scheme });
		const student = await createStudent(context);
		await holdThrottle(student.workspaceId);
		await page.goto(workspacePath(student.workspaceId));
		const notice = page.getByTestId("throttle-notice");
		await expect(notice).toBeVisible({ timeout: 15_000 });
		await expect(notice).toContainText(
			"It stays slowed after a restart because it was slowed 3 times in the last 24 hours.",
		);
		await expect(notice).not.toContainText("Stopping and starting the workspace");
		await expect(page.getByTestId("throttle-announce")).toContainText(
			"It stays slowed after a restart",
		);
		await expectNoViolations(page);
	});
}
