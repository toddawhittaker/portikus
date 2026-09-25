import * as crypto from "node:crypto";
import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { dexLocalSubject } from "../packages/auth/dist/dex-subject.js";
import { MOCK_ISSUER, query, settledAxe, WEB_ORIGIN } from "./helpers";

/**
 * axe on the change-password page and Settings, Password, in light and dark
 * (SPEC.md §25.8, docs/EPIC-14-2.md rulings 16 and 18). Each test makes its
 * own Dex local-password account in the database, so it never touches the
 * local administrator change-password.spec.ts uses. Only the browser's own
 * checks run here, so no Dex password is needed.
 */

async function expectNoViolations(page: Page, selector: string) {
	const results = await (await settledAxe(page))
		.withTags(["wcag2a", "wcag2aa", "wcag21aa"])
		.include(selector)
		.analyze();
	expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
}

/** A Dex local-password administrator with a session cookie in `context`. */
async function signInLocalAccount(context: BrowserContext, mustChange: boolean) {
	const id = `a11y-${crypto.randomUUID()}`;
	const [user] = await query<{ id: string }>(
		`insert into users (oidc_issuer, oidc_subject, email, display_name, role,
		   granted_role, must_change_password)
		 values ($1, $2, $3, 'A11y Local', 'administrator', 'administrator', $4)
		 returning id`,
		[MOCK_ISSUER, dexLocalSubject(id), `${id}@example.edu`, mustChange],
	);
	if (!user) throw new Error("could not create the test user");
	const token = crypto.randomBytes(32).toString("base64url");
	await query(
		`insert into sessions (id, user_id, expires_at)
		 values ($1, $2, now() + interval '1 hour')`,
		[crypto.createHash("sha256").update(token).digest("hex"), user.id],
	);
	await context.addCookies([
		{ name: "portikus_session", value: token, url: WEB_ORIGIN },
	]);
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
		await expect(page.getByLabel("Current password")).toBeFocused();
		await expect(page.getByLabel("Current password")).toHaveAccessibleDescription(
			"Enter your current password.",
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
