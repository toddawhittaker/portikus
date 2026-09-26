import { expect, test } from "@playwright/test";
import { createStudent, query, settledAxe } from "./helpers";

/**
 * axe on the acceptable-use page in light and dark (SPEC.md
 * sections 5.1 and 25.8). Each test clears its own student's
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

test("the keyboard alone accepts the statement", async ({ page, context }) => {
	const student = await createStudent(context);
	await query("update users set acceptable_use_version = null where id = $1", [
		student.userId,
	]);
	await page.goto("/");
	await expect(page).toHaveURL(/\/acceptable-use$/, { timeout: 15_000 });
	// Focus starts on the heading, so a screen reader announces the page.
	await expect(page.getByRole("heading", { name: "Acceptable use" })).toBeFocused();
	const accept = page.getByRole("button", { name: "I accept" });
	await expect(accept).toBeEnabled();
	for (let i = 0; i < 5; i++) {
		if (await accept.evaluate((el) => el === document.activeElement)) break;
		await page.keyboard.press("Tab");
	}
	await expect(accept).toBeFocused();
	await page.keyboard.press("Enter");
	await expect(page).toHaveURL(new RegExp(`/workspaces/${student.workspaceId}`), {
		timeout: 15_000,
	});
});

test("I accept keeps focus when the statement changed meanwhile", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	await query("update users set acceptable_use_version = null where id = $1", [
		student.userId,
	]);
	// Bumping the real version would gate every spec running alongside, so the
	// browser is shown a 409 and then a newer text.
	let changed = false;
	await page.route("**/me/acceptable-use", async (route) => {
		if (route.request().method() === "POST") {
			changed = true;
			await route.fulfill({
				status: 409,
				json: { code: "ACCEPTABLE_USE_CHANGED", message: "The statement changed." },
			});
			return;
		}
		if (!changed) return route.continue();
		await route.fulfill({ json: { text: "A newer statement.", version: 999 } });
	});
	await page.goto("/");
	await expect(page).toHaveURL(/\/acceptable-use$/, { timeout: 15_000 });
	const accept = page.getByRole("button", { name: "I accept" });
	await expect(accept).toBeEnabled();
	await accept.focus();
	await page.keyboard.press("Enter");

	await expect(page.getByTestId("acceptable-use-text")).toHaveText(
		"A newer statement.",
	);
	await expect(page.getByRole("alert")).toContainText("The statement has just changed");
	expect(await accept.evaluate((el) => el === document.activeElement)).toBe(true);
});
