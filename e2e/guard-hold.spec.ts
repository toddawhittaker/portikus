/**
 * The throttle hold (SPEC.md §19.4): the Held tag on the
 * Workspaces and Health tabs, and the student's words for a throttle a
 * restart does not lift. The worker does not run here, so each test writes
 * the held throttle row the worker would.
 */
import { type Browser, expect, test } from "@playwright/test";
import {
	createStudent,
	expectNoViolations,
	loginAs,
	query,
	workspacePath,
} from "./helpers";

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
