/**
 * Automated accessibility checks (SPEC.md section 25.8) on the /link page and
 * the Profile section's linked accounts (docs/EPIC-13-1.md, T3).
 */
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { MOCK_ISSUER, WEB_ORIGIN } from "./helpers";
import { launchAs } from "./lti-helpers";

async function expectNoViolations(page: Page, include?: string) {
	let builder = new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]);
	if (include) builder = builder.include(include);
	const results = await builder.analyze();
	expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
}

test("the Profile link section and the /link page have no automatic violations", async ({
	page,
}) => {
	test.setTimeout(120_000);
	await launchAs(page, { person: "lee" });

	await page.getByTestId("me").click();
	await page.getByRole("menuitem", { name: "Settings" }).click();
	const dialog = page.getByTestId("dialog-editor-settings");
	await dialog.getByRole("button", { name: "Profile", exact: true }).click();
	const start = dialog.getByRole("button", { name: "Link to my SSO account" });
	await expect(start).toBeVisible();
	await expectNoViolations(page, '[data-testid="dialog-editor-settings"]');

	// The confirmation page, reached the real way; nothing is confirmed. carol,
	// because account-link.spec.ts links bob and moves alice aside.
	await start.click();
	await page.waitForURL(`${MOCK_ISSUER}/authorize**`);
	await page.getByTestId("mock-user-carol").click();
	await page.waitForURL(`${WEB_ORIGIN}/link**`);
	await expect(page.getByRole("button", { name: "Link accounts" })).toBeVisible();
	await expectNoViolations(page);
});

test("the /link refusal page has no automatic violations", async ({ page }) => {
	await page.goto(`${WEB_ORIGIN}/link?error=no_account`);
	await expect(page.getByRole("alert")).toBeVisible();
	await expectNoViolations(page);
});
