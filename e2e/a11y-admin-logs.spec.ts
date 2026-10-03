import { expect, test } from "@playwright/test";
import {
	createStudent,
	loginAs,
	openToggletip,
	settledAxe,
	WCAG_TAGS,
	WEB_ORIGIN,
} from "./helpers";

/**
 * Automated accessibility checks (SPEC.md section 25.8) on the Logs tab with
 * a row expanded, and with an empty result and a refused Person entry, in
 * both themes (SPEC.md section 24.11).
 */
for (const colorScheme of ["light", "dark"] as const) {
	test(`the Logs tab has no automatic accessibility violations (${colorScheme})`, async ({
		page,
		browser,
	}) => {
		// A student whose workspace is stopped: asking for a terminal is refused and logged at info.
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
			await page.goto(
				`/admin/logs?level=info&q=AGENT_UNAVAILABLE&user=${student.userId}`,
			);
			await expect(page.getByTestId("log-row").first()).toBeVisible({ timeout: 2_000 });
		}).toPass({ timeout: 20_000 });
		await page.getByTestId("log-row-toggle").first().click();
		await expect(page.getByTestId("log-row-detail")).toBeVisible();

		const results = await (await settledAxe(page)).withTags(WCAG_TAGS).analyze();
		expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
	});
}

for (const colorScheme of ["light", "dark"] as const) {
	test(`the Logs tab's empty and error states have no automatic accessibility violations (${colorScheme})`, async ({
		page,
	}) => {
		await page.emulateMedia({ colorScheme });
		await loginAs(page, "carol");
		// A text no line has, so the result is empty.
		await page.goto("/admin/logs?q=no-line-says-this-e2e");
		await expect(page.getByTestId("logs-empty")).toBeVisible({ timeout: 15_000 });
		await page.getByRole("combobox", { name: "Person" }).fill("Nobody By This Name");
		await page.getByRole("button", { name: "Apply filters" }).click();
		await expect(page.getByText("Choose a person from the list.")).toBeVisible();

		const results = await (await settledAxe(page)).withTags(WCAG_TAGS).analyze();
		expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
	});
}

for (const colorScheme of ["light", "dark"] as const) {
	test(`the Logs tab with its intro and a help tip open has no automatic accessibility violations (${colorScheme})`, async ({
		page,
	}) => {
		await page.emulateMedia({ colorScheme });
		await loginAs(page, "carol");
		await page.goto("/admin/logs?q=no-line-says-this-e2e");
		await expect(page.getByTestId("logs-empty")).toBeVisible({ timeout: 15_000 });
		await expect(page.getByTestId("intro-admin-logs")).toContainText(
			"They never include students' files, commands or terminal output.",
		);
		await page.getByRole("button", { name: "About Service log level" }).click();
		await expect(openToggletip(page)).toContainText("Debug fills the journal quickly");

		const results = await (await settledAxe(page)).withTags(WCAG_TAGS).analyze();
		expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
	});
}
