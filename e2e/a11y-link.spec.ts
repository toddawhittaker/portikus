/**
 * Automated accessibility checks (SPEC.md section 25.8) on the /link page and
 * the Profile section's linked accounts (docs/EPIC-13-1.md, T3). Max (mock
 * LMS) and gail (mock OIDC) exist for this spec alone.
 */
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { apiLoginAs, MOCK_ISSUER, WEB_ORIGIN } from "./helpers";
import { launchAs } from "./lti-helpers";

async function expectNoViolations(page: Page, include?: string) {
	let builder = new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]);
	if (include) builder = builder.include(include);
	const results = await builder.analyze();
	expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
}

test("the Profile link section and the /link page have no automatic violations", async ({
	browser,
	page,
}) => {
	test.setTimeout(120_000);
	// gail needs an account to reach the confirmation page.
	const gail = await browser.newContext({ baseURL: WEB_ORIGIN });
	await apiLoginAs(gail.request, "gail");
	await gail.close();

	await launchAs(page, { person: "max" });

	await page.getByTestId("me").click();
	await page.getByRole("menuitem", { name: "Settings" }).click();
	const dialog = page.getByTestId("dialog-editor-settings");
	await dialog.getByRole("button", { name: "Profile", exact: true }).click();
	const start = dialog.getByRole("button", { name: "Link to my SSO account" });
	await expect(start).toBeVisible();
	await expectNoViolations(page, '[data-testid="dialog-editor-settings"]');

	// The SSO sign-in opens in a new tab; this one waits with a named control in focus.
	const [tab] = await Promise.all([page.context().waitForEvent("page"), start.click()]);
	const reopen = dialog.getByRole("button", { name: "Open the sign-in tab again" });
	await expect(reopen).toBeFocused();
	await expectNoViolations(page, '[data-testid="dialog-editor-settings"]');

	// The confirmation page, reached the real way.
	await tab.waitForURL(`${MOCK_ISSUER}/authorize**`);
	await tab.getByTestId("mock-user-gail").click();
	await tab.waitForURL(`${WEB_ORIGIN}/link**`);
	await expect(tab.getByRole("button", { name: "Link accounts" })).toBeVisible();
	await expectNoViolations(tab);

	// Link in the new tab, which reloads this one; then unlink as gail: focus
	// must not fall back to the page body.
	await Promise.all([
		page.waitForEvent("load", { timeout: 30_000 }),
		tab.getByRole("button", { name: "Link accounts" }).click(),
	]);
	await page.waitForURL(`${WEB_ORIGIN}/workspaces/**`, { timeout: 30_000 });
	await page.getByTestId("me").click();
	await page.getByRole("menuitem", { name: "Settings" }).click();
	await dialog.getByRole("button", { name: "Profile", exact: true }).click();
	const region = dialog.getByRole("region", { name: "Linked accounts" });
	await region.getByRole("button", { name: /^Unlink / }).click();
	await expect(region).toContainText("No course sign-ins are linked");
	await expect(region.getByRole("heading", { name: "Linked accounts" })).toBeFocused();
	expect(await page.evaluate(() => document.activeElement === document.body)).toBe(
		false,
	);
});

test("the /link refusal page has no automatic violations", async ({ page }) => {
	await page.goto(`${WEB_ORIGIN}/link?error=no_account`);
	await expect(page.getByRole("alert")).toBeVisible();
	await expectNoViolations(page);
});
