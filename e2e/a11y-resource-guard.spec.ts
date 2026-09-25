/**
 * Automated accessibility checks (SPEC.md section 25.8) on the resource
 * guard's screens (ADR 0032): the student's slowed-down and Still working?
 * notices, the admin detail section and its overrides dialog, the Settings
 * sections, and the Health tab's list, each in the light and dark themes.
 */
import { expect, type Page, test } from "@playwright/test";
import { createStudent, loginAs, query, settledAxe, workspacePath } from "./helpers";

async function expectNoViolations(page: Page) {
	const results = await (await settledAxe(page))
		.withTags(["wcag2a", "wcag2aa", "wcag21aa"])
		.analyze();
	expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
}

/** Throttled and waiting on "Still working?", as the worker would leave it. */
async function throttleAndWarn(workspaceId: string): Promise<void> {
	await query(
		`update workspaces
		    set cpu_throttle = $2,
		        memory_flag = $3,
		        last_activity_at = now() - interval '60 minutes',
		        idle_stop_at = now() + interval '5 minutes',
		        updated_at = now()
		  where id = $1`,
		[
			workspaceId,
			JSON.stringify({
				at: new Date().toISOString(),
				averagePercent: 97,
				thresholdPercent: 80,
				windowMinutes: 30,
				sharePercent: 25,
				allowance: "100ms/100ms",
			}),
			JSON.stringify({
				at: new Date().toISOString(),
				averagePercent: 93,
				thresholdPercent: 90,
				windowMinutes: 30,
			}),
		],
	);
}

for (const scheme of ["light", "dark"] as const) {
	test(`the student's notices have no automatic violations (${scheme})`, async ({
		page,
		context,
	}) => {
		await page.emulateMedia({ colorScheme: scheme });
		const student = await createStudent(context);
		await throttleAndWarn(student.workspaceId);
		await page.goto(workspacePath(student.workspaceId));
		await expect(page.getByTestId("throttle-notice")).toBeVisible({ timeout: 15_000 });
		await expect(page.getByTestId("idle-notice")).toBeVisible();
		await expectNoViolations(page);
	});

	test(`the admin guard screens have no automatic violations (${scheme})`, async ({
		page,
		browser,
	}) => {
		await page.emulateMedia({ colorScheme: scheme });
		const other = await browser.newContext();
		const student = await createStudent(other);
		await other.close();
		const name = `A11y guard ${student.userId.slice(0, 8)}`;
		await query("update users set display_name = $2 where id = $1", [
			student.userId,
			name,
		]);
		await throttleAndWarn(student.workspaceId);

		await loginAs(page, "carol");
		await page.goto("/admin?tab=settings");
		await expect(page.getByLabel("Statement")).toBeVisible({ timeout: 15_000 });
		await page.getByTestId("idle-input").fill("5");
		await page.getByTestId("idle-save").click();
		await expect(page.getByRole("alert")).toBeVisible();
		await expectNoViolations(page);

		await page.goto("/admin?tab=health");
		await expect(page.getByTestId("health-guard")).toBeVisible({ timeout: 15_000 });
		await expectNoViolations(page);

		await page.goto(`/admin?tab=workspaces&user=${student.userId}`);
		const panel = page.getByRole("region", { name });
		await expect(panel.getByTestId("detail-lift-throttle")).toBeVisible({
			timeout: 15_000,
		});
		await expectNoViolations(page);

		await panel.getByTestId("detail-guard-edit").click();
		const dialog = page.getByRole("dialog", { name: "Resource guard overrides" });
		await dialog.getByLabel("Window (minutes)").fill("1");
		await dialog.getByTestId("guard-save").click();
		await expect(dialog.getByRole("alert")).toBeVisible();
		await expectNoViolations(page);
	});
}
