import { readFile } from "node:fs/promises";
import { type BrowserContext, expect, test } from "@playwright/test";
import {
	createLocalPasswordAdmin,
	expectNoViolations,
	query,
	TestAuthenticator,
} from "./helpers";

/**
 * axe on the two-step sign-in pages, in light and dark (SPEC.md sections
 * 24.13 and 25.8). Each test makes its own Dex local-password account in
 * the database, with a session that has not passed the check yet.
 */
async function signInPending(context: BrowserContext): Promise<string> {
	const userId = await createLocalPasswordAdmin(context, {
		prefix: "a11y-2fa",
		displayName: "A11y Two Step",
		mustChange: false,
	});
	await query("update sessions set second_factor_at = null where user_id = $1", [
		userId,
	]);
	return userId;
}

for (const colorScheme of ["light", "dark"] as const) {
	test(`the setup page has no axe violations, with and without an error, in ${colorScheme}`, async ({
		page,
		context,
	}) => {
		await page.emulateMedia({ colorScheme });
		await signInPending(context);
		await page.goto("/admin");
		await expect(page).toHaveURL(/\/second-factor$/, { timeout: 15_000 });
		const heading = page.getByRole("heading", { name: "Set up two-step sign-in" });
		await expect(heading).toBeFocused();
		await expect(page.getByTestId("totp-qr")).toBeVisible();
		await expectNoViolations(page, "[data-testid=page-second-factor]");

		await page.getByRole("button", { name: "Turn on two-step sign-in" }).click();
		const field = page.getByLabel("Code from your app");
		await expect(field).toBeFocused();
		await expect(field).toHaveAccessibleDescription(
			"Enter the 6-digit code from your app.",
		);
		await expectNoViolations(page, "[data-testid=page-second-factor]");

		// The key reads in groups of four, and the copy is confirmed.
		const key = (await page.getByTestId("totp-secret").textContent()) ?? "";
		expect(key).toMatch(/^[A-Z2-7]{4}( [A-Z2-7]{1,4})+$/);
		await page.getByRole("button", { name: "Copy key" }).click();
		await expect(page.getByRole("status").filter({ hasText: /cop/i })).toBeVisible();
		await expectNoViolations(page, "[data-testid=page-second-factor]");

		const app = TestAuthenticator.fromKey(key);
		await field.fill(await app.nextCode());
		await page.getByRole("button", { name: "Turn on two-step sign-in" }).click();
		await expect(
			page.getByRole("heading", { name: "Save your recovery codes" }),
		).toBeFocused();
		const codes = await page
			.getByTestId("recovery-codes")
			.getByRole("listitem")
			.allTextContents();
		const download = page.waitForEvent("download");
		await page.getByRole("button", { name: "Download codes" }).click();
		const file = await download;
		expect(file.suggestedFilename()).toBe("portikus-recovery-codes.txt");
		expect(await readFile(await file.path(), "utf8")).toBe(`${codes.join("\n")}\n`);
		await page.getByRole("button", { name: "Copy codes" }).click();
		await expect(page.getByRole("status").filter({ hasText: /cop/i })).toBeVisible();
		await expectNoViolations(page, "[data-testid=page-second-factor]");
	});

	test(`the code page has no axe violations, in both modes, in ${colorScheme}`, async ({
		page,
		context,
	}) => {
		await page.emulateMedia({ colorScheme });
		const userId = await signInPending(context);
		await query(
			`insert into user_second_factors (user_id, kind, secret, label)
			 values ($1, 'totp', 'v1:unreadable', 'Phone')`,
			[userId],
		);
		await page.goto("/");
		await expect(page).toHaveURL(/\/second-factor$/, { timeout: 15_000 });
		await expect(page.getByRole("heading", { name: "Two-step sign-in" })).toBeFocused();
		await expectNoViolations(page, "[data-testid=page-second-factor]");

		await page.getByRole("button", { name: "Continue" }).click();
		await expect(page.getByLabel("Code from your app")).toBeFocused();
		await expectNoViolations(page, "[data-testid=page-second-factor]");

		await page.getByRole("button", { name: "Use a recovery code" }).click();
		await expect(page.getByLabel("Recovery code")).toBeFocused();
		await expectNoViolations(page, "[data-testid=page-second-factor]");
	});
}
