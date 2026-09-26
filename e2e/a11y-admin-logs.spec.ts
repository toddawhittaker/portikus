import { expect, test } from "@playwright/test";
import { createStudent, loginAs, settledAxe, WEB_ORIGIN } from "./helpers";

/**
 * Automated accessibility checks (SPEC.md section 25.8) on the Logs tab with
 * a row expanded, in both themes (docs/EPIC-19.md, "After every task").
 */
for (const colorScheme of ["light", "dark"] as const) {
	test(`the Logs tab has no automatic accessibility violations (${colorScheme})`, async ({
		page,
		browser,
	}) => {
		// A student whose workspace is stopped: asking for a terminal is refused and logged.
		const context = await browser.newContext({ baseURL: WEB_ORIGIN });
		const student = await createStudent(context, { state: "stopped" });
		const refused = await context.request.post(
			`/workspaces/${student.workspaceId}/terminals`,
			{ headers: { origin: WEB_ORIGIN }, data: {} },
		);
		expect(refused.status()).toBe(409);
		await context.close();

		await page.emulateMedia({ colorScheme });
		await loginAs(page, "carol");
		await expect(async () => {
			await page.goto(`/admin?tab=logs&user=${student.userId}`);
			await expect(page.getByTestId("log-row").first()).toBeVisible({ timeout: 2_000 });
		}).toPass({ timeout: 20_000 });
		await page.getByTestId("log-row-toggle").first().click();
		await expect(page.getByTestId("log-row-detail")).toBeVisible();

		const results = await (await settledAxe(page))
			.withTags(["wcag2a", "wcag2aa", "wcag21aa"])
			.analyze();
		expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
	});
}
