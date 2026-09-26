import { expect, test } from "@playwright/test";
import { createStudent, query, settledAxe } from "./helpers";

/**
 * axe on the acceptable-use page in light and dark (docs/EPIC-14-3.md
 * ruling 33, SPEC.md section 25.8). Each test clears its own student's
 * acceptance, so no other spec meets the gate.
 */

for (const colorScheme of ["light", "dark"] as const) {
	test(`the acceptable-use page has no axe violations in ${colorScheme}`, async ({
		page,
		context,
	}) => {
		await page.emulateMedia({ colorScheme });
		const student = await createStudent(context);
		await query("update users set acceptable_use_version = null where id = $1", [
			student.userId,
		]);
		await page.goto("/");
		await expect(page).toHaveURL(/\/acceptable-use$/, { timeout: 15_000 });
		await expect(page.getByTestId("acceptable-use-text")).toBeVisible();
		await expect(page.getByRole("button", { name: "I accept" })).toBeEnabled();

		const results = await (await settledAxe(page))
			.withTags(["wcag2a", "wcag2aa", "wcag21aa"])
			.include("[data-testid=page-acceptable-use]")
			.analyze();
		expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
	});
}
