import { type BrowserContext, expect, test } from "@playwright/test";
import { createLocalPasswordAdmin, expectNoViolations } from "./helpers";

/**
 * axe on the change-password page and Settings, Password, in light and dark
 * (SPEC.md sections 5.3 and 25.8). Each test makes its
 * own Dex local-password account in the database, so it never touches the
 * local administrator change-password.spec.ts uses. Only the browser's own
 * checks run here, so no Dex password is needed.
 */

/** A Dex local-password administrator with a session cookie in `context`. */
async function signInLocalAccount(context: BrowserContext, mustChange: boolean) {
	await createLocalPasswordAdmin(context, {
		prefix: "a11y",
		displayName: "A11y Local",
		mustChange,
	});
}

for (const colorScheme of ["light", "dark"] as const) {
	test(`the change-password page has no axe violations, with and without errors, in ${colorScheme}`, async ({
		page,
		context,
	}) => {
		await page.emulateMedia({ colorScheme });
		await signInLocalAccount(context, true);
		await page.goto("/admin");
		await expect(page).toHaveURL(/\/change-password$/, { timeout: 15_000 });
		await expect(
			page.getByRole("heading", { name: "Set a new password" }),
		).toBeVisible();
		await expectNoViolations(page, "[data-testid=page-change-password]");

		await page.getByRole("button", { name: "Change password" }).click();
		const current = page.getByLabel("Current or one-time password");
		await expect(current).toBeFocused();
		await expect(current).toHaveAccessibleDescription(
			"If an administrator gave you a one-time password, enter it here. Enter your current or one-time password.",
		);
		await expectNoViolations(page, "[data-testid=page-change-password]");
	});

	test(`Settings, Password has no axe violations in ${colorScheme}`, async ({
		page,
		context,
	}) => {
		await page.emulateMedia({ colorScheme });
		await signInLocalAccount(context, false);
		await page.goto("/admin");
		await expect(page.getByTestId("admin-accounts")).toBeVisible({ timeout: 15_000 });
		await page.getByTestId("me").click();
		await page.getByRole("menuitem", { name: "Settings" }).click();
		const dialog = page.getByTestId("dialog-editor-settings");
		await dialog.getByRole("button", { name: "Password", exact: true }).click();
		await expect(
			dialog.getByRole("heading", { name: "Password", exact: true }),
		).toBeVisible();
		await expectNoViolations(page, "[data-testid=dialog-editor-settings]");

		await dialog.getByLabel("Current password").fill("anything");
		await dialog.getByLabel("New password", { exact: true }).fill("short");
		await dialog.getByRole("button", { name: "Change password" }).click();
		await expect(dialog.getByLabel("New password", { exact: true })).toBeFocused();
		await expectNoViolations(page, "[data-testid=dialog-editor-settings]");
	});
}
