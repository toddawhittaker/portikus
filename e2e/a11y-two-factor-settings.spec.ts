import { expect, test } from "@playwright/test";
import { createLocalPasswordAdmin, expectNoViolations, query } from "./helpers";

/**
 * axe on Settings, Two-factor sign-in, in light and dark (SPEC.md sections
 * 24.13 and 25.8): the list, the rename form, the refusal to remove the
 * last factor, and new recovery codes.
 */
for (const colorScheme of ["light", "dark"] as const) {
	test(`Settings, Two-factor sign-in has no axe violations in ${colorScheme}`, async ({
		page,
		context,
	}) => {
		await page.emulateMedia({ colorScheme });
		const userId = await createLocalPasswordAdmin(context, {
			prefix: "a11y-2fa-settings",
			displayName: "A11y Two Factor",
			mustChange: false,
		});
		await query(
			`insert into user_second_factors (user_id, kind, secret, label)
			 values ($1, 'totp', 'v1:unreadable', 'Phone')`,
			[userId],
		);
		await page.goto("/admin");
		await expect(page.getByTestId("admin-accounts")).toBeVisible({ timeout: 15_000 });
		await page.getByTestId("me").click();
		await page.getByRole("menuitem", { name: "Settings" }).click();
		const dialog = page.getByTestId("dialog-editor-settings");
		await dialog.getByRole("button", { name: "Two-factor sign-in" }).click();
		await expect(dialog.getByTestId("factor-totp")).toBeVisible();
		await expectNoViolations(page, "[data-testid=dialog-editor-settings]");

		await dialog.getByRole("button", { name: "Remove Phone" }).click();
		await expect(dialog.getByTestId("factor-remove-error")).toBeVisible();
		await expectNoViolations(page, "[data-testid=dialog-editor-settings]");

		await dialog.getByRole("button", { name: "Rename Phone" }).click();
		await expect(dialog.getByLabel("Name")).toBeFocused();
		await dialog.getByLabel("Name").fill("");
		await dialog.getByRole("button", { name: "Save name" }).click();
		await expect(dialog.getByLabel("Name")).toHaveAccessibleDescription(
			"Give it a name.",
		);
		await expectNoViolations(page, "[data-testid=dialog-editor-settings]");
		await dialog.getByRole("button", { name: "Cancel" }).click();

		await dialog.getByRole("button", { name: "Make new recovery codes" }).click();
		await expect(
			dialog.getByRole("heading", { name: "Your new recovery codes" }),
		).toBeFocused();
		await expectNoViolations(page, "[data-testid=dialog-editor-settings]");

		await page.getByRole("button", { name: "I have saved them, continue" }).click();
		await dialog.getByRole("button", { name: "Add an authenticator app" }).click();
		await expect(dialog.getByTestId("totp-qr")).toBeVisible();
		await expectNoViolations(page, "[data-testid=dialog-editor-settings]");
	});
}
