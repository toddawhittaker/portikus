import * as crypto from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { loginAs, MOCK_ISSUER, query } from "./helpers";

/**
 * Bulk actions on the Users view (Epic 13.1 T4): tick rows, confirm a
 * dialog that names each one, and each row's own admin route is called.
 */

async function insertStudent(name: string): Promise<string> {
	const [row] = await query<{ id: string }>(
		`insert into users (oidc_issuer, oidc_subject, email, display_name, role)
		 values ($1, $2, $3, $4, 'student') returning id`,
		[
			MOCK_ISSUER,
			`e2e-${crypto.randomUUID()}`,
			`${crypto.randomUUID()}@example.edu`,
			name,
		],
	);
	if (!row) throw new Error("could not create the user");
	return row.id;
}

test("an administrator disables two accounts at once", async ({ page }) => {
	const tag = crypto.randomUUID().slice(0, 8);
	const first = `Bulk ${tag} One`;
	const second = `Bulk ${tag} Two`;
	const ids = [await insertStudent(first), await insertStudent(second)];

	await loginAs(page, "carol");
	await page.goto("/admin");
	await expect(page.getByTestId("admin-accounts")).toBeVisible({ timeout: 15_000 });
	await page.getByTestId("admin-filter-text").fill(`Bulk ${tag}`);
	await expect(page.locator("[data-testid^=account-row-]")).toHaveCount(2);

	// Select all by keyboard.
	await page.getByRole("checkbox", { name: "Select all shown accounts" }).focus();
	await page.keyboard.press("Space");
	await expect(page.getByRole("checkbox", { name: `Select ${first}` })).toBeChecked();
	await expect(page.getByRole("checkbox", { name: `Select ${second}` })).toBeChecked();

	const bar = page.getByTestId("bulk-actions");
	await expect(bar).toContainText("2 selected");
	await expect(bar.getByRole("button", { name: "Enable…" })).toHaveCount(0);
	await bar.getByRole("button", { name: "Disable…" }).click();

	const dialog = page.getByRole("alertdialog", { name: "Disable 2 accounts?" });
	await expect(dialog.getByTestId("bulk-dialog-names")).toHaveText(
		`${first} and ${second}.`,
	);
	expect(
		(
			await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze()
		).violations.map((v) => v.id),
	).toEqual([]);
	await dialog.getByRole("button", { name: "Disable" }).click();

	await expect(page.getByTestId("bulk-result")).toHaveText(
		`Disabled ${first} and ${second}.`,
	);
	const rows = await query<{ disabled_at: Date | null }>(
		"select disabled_at from users where id = any($1)",
		[ids],
	);
	expect(rows.every((row) => row.disabled_at !== null)).toBe(true);
	for (const id of ids) {
		await expect(
			page.getByTestId(`account-row-${id}`).getByText("Disabled", { exact: true }),
		).toBeVisible();
	}
});
