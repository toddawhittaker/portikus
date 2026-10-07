/**
 * Automated accessibility checks (SPEC.md section 25.8) on the /link page and
 * the Profile section's linked accounts (ADR 0026). Max (mock
 * LMS) and gail (mock OIDC) exist for this spec alone.
 */
import { expect, type Page, test } from "@playwright/test";
import {
	apiLoginAs,
	expectNoViolations,
	MOCK_ISSUER,
	routeApi,
	WEB_ORIGIN,
} from "./helpers";
import { launchAs } from "./lti-helpers";

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

/** The /link page with its pending link answered by the test, at the given second-factor step. */
async function openStubbedLink(page: Page, secondFactor: "verify" | "enrol") {
	await routeApi(page, "**/me/links/pending", (route) =>
		route.fulfill({
			json: {
				course: { displayName: "Max Learner", platformName: "mock-lms" },
				sso: { displayName: "Lars Local", signInName: "lars", email: null },
				secondFactor,
			},
		}),
	);
	await routeApi(page, "**/me/links/confirm", (route) =>
		route.fulfill({
			status: 400,
			json: {
				code: "VALIDATION_FAILED",
				message: "That code did not work. Enter a new code from your app.",
			},
		}),
	);
	await page.goto(`${WEB_ORIGIN}/link`);
}

for (const colorScheme of ["light", "dark"] as const) {
	test(`the /link code step has no automatic violations, before and after a wrong code (${colorScheme})`, async ({
		page,
	}) => {
		await page.emulateMedia({ colorScheme });
		await openStubbedLink(page, "verify");
		const field = page.getByLabel("Two-step sign-in code");
		await expect(field).toBeVisible();
		await expectNoViolations(page);

		await page.getByRole("button", { name: "Link accounts" }).click();
		// The field itself carries the error and takes focus (SPEC.md 25.8).
		await expect(field).toHaveAttribute("aria-invalid", "true");
		await expect(field).toHaveAccessibleDescription(/That code did not work/);
		await expect(field).toBeFocused();
		await expectNoViolations(page);
	});

	test(`the /link status line takes no room while empty and announces linking (${colorScheme})`, async ({
		page,
	}) => {
		await page.emulateMedia({ colorScheme });
		let answer: () => void = () => {};
		const answered = new Promise<void>((resolve) => {
			answer = resolve;
		});
		await routeApi(page, "**/me/links/pending", (route) =>
			route.fulfill({
				json: {
					course: { displayName: "Max Learner", platformName: "mock-lms" },
					sso: { displayName: "Gail Org", signInName: "gail", email: null },
					secondFactor: null,
				},
			}),
		);
		// Held open so the in-progress text can be seen; never answered with success.
		await routeApi(page, "**/me/links/confirm", async (route) => {
			await answered;
			await route.fulfill({
				status: 404,
				json: { code: "NOT_FOUND", message: "Not found" },
			});
		});
		await page.goto(`${WEB_ORIGIN}/link`);

		const status = page.getByTestId("link-status");
		await expect(status).toHaveAttribute("role", "status");
		await expect(status).toBeEmpty();
		const accounts = page.getByTestId("link-accounts");
		const actions = page.getByRole("button", { name: "Cancel" });
		// Empty, the live region adds no height and no extra gap: the actions
		// sit one panel gap below the accounts list.
		const gap = await page
			.locator(".pk-standalone-panel")
			.evaluate((panel) => Number.parseFloat(getComputedStyle(panel).rowGap));
		const below = async () => {
			const list = await accounts.boundingBox();
			const button = await actions.boundingBox();
			if (!list || !button) throw new Error("layout not measured");
			return button.y - (list.y + list.height);
		};
		expect((await status.boundingBox())?.height ?? 0).toBe(0);
		expect(Math.round(await below())).toBe(gap);
		await expectNoViolations(page);

		await page.getByRole("button", { name: "Link accounts" }).click();
		await expect(status).toHaveText("Linking your accounts…");
		expect((await status.boundingBox())?.height ?? 0).toBeGreaterThan(0);
		await expectNoViolations(page);
		answer();
		await expect(page.getByRole("alert")).toBeVisible();
	});

	test(`the /link "set up two-step sign-in first" message has no automatic violations (${colorScheme})`, async ({
		page,
	}) => {
		await page.emulateMedia({ colorScheme });
		await openStubbedLink(page, "enrol");
		await expect(page.getByRole("alert")).toContainText("set up two-step sign-in");
		await expectNoViolations(page);
	});
}
