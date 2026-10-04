/**
 * Automated accessibility checks (SPEC.md section 25.8) on the Invite
 * dialog, the waiting invitations table and the not-invited page
 * (SPEC.md section 24.13), in the light and dark themes.
 */
import * as crypto from "node:crypto";
import { expect, test } from "@playwright/test";
import { expectNoViolations, loginAs, query } from "./helpers";

for (const scheme of ["light", "dark"] as const) {
	test(`the Invite dialog and the waiting invitations have no automatic violations (${scheme})`, async ({
		page,
	}) => {
		await page.emulateMedia({ colorScheme: scheme });
		const tag = crypto.randomUUID().slice(0, 8);
		await query(
			`insert into account_invitations (email, display_name, role)
			 values ($1, $2, 'instructor')`,
			[`axe-${tag}@example.edu`, `Axe ${tag}`],
		);
		await loginAs(page, "carol");
		await page.goto("/admin");
		// Only this invitation, so the scan does not grow with the run's accounts.
		await page.getByTestId("admin-filter-text").fill(`axe-${tag}@example.edu`);
		await expect(page.getByTestId(`invitation-axe-${tag}@example.edu`)).toBeVisible({
			timeout: 15_000,
		});
		await expectNoViolations(page, "[data-testid=admin-accounts]");

		await page.getByRole("button", { name: "Invite…" }).click();
		const dialog = page.getByRole("dialog", { name: "Invite someone" });
		await expect(dialog).toBeVisible();
		await expectNoViolations(page, "[data-testid=invite-dialog]");
		// With every field's error showing.
		await dialog.getByRole("button", { name: "Invite" }).click();
		await expect(dialog.getByLabel("Name", { exact: true })).toBeFocused();
		await expectNoViolations(page, "[data-testid=invite-dialog]");
	});

	test(`the not-invited page has no automatic violations (${scheme})`, async ({
		page,
	}) => {
		await page.emulateMedia({ colorScheme: scheme });
		await page.goto("/not-invited");
		await expect(page.getByTestId("page-not-invited")).toBeVisible();
		await expectNoViolations(page);
	});
}
