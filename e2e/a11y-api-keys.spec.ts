import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { expectNoViolations, loginAs } from "./helpers";

/**
 * axe on Settings, API keys and the admin API keys tab, in dark and light
 * (SPEC.md sections 24.13 and 25.8): the list, the create form with an
 * error, the secret shown once, and each confirm.
 */
const DIALOG = "[data-testid=dialog-editor-settings]";

for (const colorScheme of ["dark", "light"] as const) {
	test(`Settings, API keys has no axe violations in ${colorScheme}`, async ({
		page,
	}) => {
		await page.emulateMedia({ colorScheme });
		await loginAs(page, "carol");
		await page.goto("/admin");
		await expect(page.getByTestId("admin-accounts")).toBeVisible({ timeout: 15_000 });
		await page.getByTestId("me").click();
		await page.getByRole("menuitem", { name: "Settings" }).click();
		const dialog = page.getByTestId("dialog-editor-settings");
		await dialog.getByRole("button", { name: "API keys", exact: true }).click();
		await expect(dialog.getByRole("heading", { name: "Your API keys" })).toBeVisible();

		await dialog.getByRole("button", { name: "Create an API key" }).click();
		await expect(
			dialog.getByRole("heading", { name: "Create an API key" }),
		).toBeFocused();
		await dialog.getByTestId("api-key-create-submit").click();
		await expect(dialog.getByLabel("Name")).toHaveAccessibleDescription(
			/Give the key a name/,
		);
		await expectNoViolations(page, DIALOG);

		const name = `A11y ${randomUUID().slice(0, 8)}`;
		await dialog.getByLabel("Name").fill(name);
		await dialog.getByTestId("api-key-create-submit").click();
		await expect(dialog.getByTestId("api-key-secret")).toBeVisible();
		await expectNoViolations(page, DIALOG);
		await dialog.getByTestId("api-key-secret-done").click();

		const row = dialog.getByRole("listitem").filter({ hasText: name });
		await expect(row).toBeVisible();
		await expectNoViolations(page, DIALOG);

		await row.getByRole("button", { name: "Renew with a new secret…" }).click();
		await expect(page.getByTestId("api-key-rotate-confirm")).toBeVisible();
		await expectNoViolations(page, "[data-testid=api-key-rotate-confirm]");
		await page.keyboard.press("Escape");

		await row.getByRole("button", { name: "Revoke…" }).click();
		await expect(page.getByTestId("api-key-revoke-confirm")).toBeVisible();
		await expectNoViolations(page, "[data-testid=api-key-revoke-confirm]");
		await page
			.getByTestId("api-key-revoke-confirm")
			.getByRole("button", { name: "Revoke key" })
			.click();
		await expect(row.getByTestId("api-key-state")).toHaveText("Revoked");
		await expectNoViolations(page, DIALOG);
	});

	test(`the admin API keys tab has no axe violations in ${colorScheme}`, async ({
		page,
	}) => {
		await page.emulateMedia({ colorScheme });
		await loginAs(page, "carol");
		// A key of Carol's own, so the table has a row with its actions.
		await page.goto("/admin");
		await expect(page.getByTestId("admin-accounts")).toBeVisible({ timeout: 15_000 });
		await page.evaluate(
			(name) =>
				fetch("/me/api-keys", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ name }),
				}),
			`A11y admin ${randomUUID().slice(0, 8)}`,
		);
		await page.goto("/admin/keys");
		await expect(page.getByTestId("api-keys-table")).toBeVisible({ timeout: 15_000 });
		await expectNoViolations(page, "main");

		await page.getByTestId("api-keys-expire-all").click();
		await expect(page.getByTestId("api-keys-confirm")).toBeVisible();
		await expectNoViolations(page, "[data-testid=api-keys-confirm]");
		await page.keyboard.press("Escape");
		await expect(page.getByTestId("api-keys-confirm")).toBeHidden();
	});
}
