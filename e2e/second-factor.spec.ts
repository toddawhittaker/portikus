import { type Browser, expect, type Page, test } from "@playwright/test";
import { enrolSecondFactor, loginAs, query, type TestAuthenticator } from "./helpers";

/**
 * Two-step sign-in for a Dex local password (SPEC.md section 24.13). The mock
 * provider's "lena" is a student with a Dex local-password subject, so each
 * sign-in goes through the real callback and the gate. The tests share her
 * one account and run in order.
 */
test.describe.configure({ mode: "serial" });

let app: TestAuthenticator;
let codes: string[] = [];

/** Sign lena in from a fresh browser, as a new sign-in on another day would. */
async function freshSignIn(browser: Browser): Promise<Page> {
	const context = await browser.newContext();
	const page = await context.newPage();
	await loginAs(page, "lena");
	await expect(page).toHaveURL(/\/second-factor$/, { timeout: 15_000 });
	await expect(page.getByRole("heading", { name: "Two-step sign-in" })).toBeVisible();
	return page;
}

test.beforeAll(async () => {
	// A clean start, whatever an earlier run on this database left behind.
	await query(
		"delete from user_second_factors where user_id in (select id from users where email = $1)",
		["lena@example.edu"],
	);
});

test("a first sign-in sets up an authenticator before anything else", async ({
	page,
}) => {
	await loginAs(page, "lena");
	await expect(page).toHaveURL(/\/second-factor$/, { timeout: 15_000 });
	for (const path of ["/", "/admin", "/course"]) {
		await page.goto(path);
		await expect(page).toHaveURL(/\/second-factor$/, { timeout: 15_000 });
	}
	await expect(page.getByTestId("totp-qr")).toBeVisible();
	// The server refuses the rest too.
	const blocked = await page.request.get("/me/settings");
	expect(blocked.status()).toBe(403);
	expect((await blocked.json()).code).toBe("SECOND_FACTOR_REQUIRED");

	// A wrong first code is shown on the field, which keeps focus.
	await page.getByLabel("Code from your app").fill("000000");
	await page.getByRole("button", { name: "Turn on two-step sign-in" }).click();
	const field = page.getByLabel("Code from your app");
	await expect(field).toBeFocused();
	await expect(field).toHaveAccessibleDescription(/That code is not right/);

	({ app, codes } = await enrolSecondFactor(page));
	expect(codes).toHaveLength(10);
	await expect(page.getByTestId("app-header")).toBeVisible({ timeout: 15_000 });
});

test("signing in again asks for a code, and a wrong one says so", async ({
	browser,
}) => {
	const page = await freshSignIn(browser);
	const field = page.getByLabel("Code from your app");
	await expect(field).toHaveAttribute("autocomplete", "one-time-code");
	await field.fill("000000");
	await page.getByRole("button", { name: "Continue" }).click();
	await expect(field).toBeFocused();
	await expect(field).toHaveAccessibleDescription(
		"That code is not right. Try the newest code from your app, or a recovery code.",
	);

	await field.fill(await app.nextCode());
	await page.getByRole("button", { name: "Continue" }).click();
	await expect(page).not.toHaveURL(/\/second-factor$/, { timeout: 15_000 });
	await expect(page.getByTestId("app-header")).toBeVisible({ timeout: 15_000 });
	await page.context().close();
});

test("a recovery code signs in once", async ({ browser }) => {
	const code = codes[0] as string;
	const page = await freshSignIn(browser);
	await page.getByRole("button", { name: "Use a recovery code" }).click();
	await expect(page.getByLabel("Recovery code")).toBeFocused();
	await page.getByLabel("Recovery code").fill(code.toLowerCase());
	await page.getByRole("button", { name: "Continue" }).click();
	await expect(page).not.toHaveURL(/\/second-factor$/, { timeout: 15_000 });
	await page.context().close();

	const again = await freshSignIn(browser);
	await again.getByRole("button", { name: "Use a recovery code" }).click();
	await again.getByLabel("Recovery code").fill(code);
	await again.getByRole("button", { name: "Continue" }).click();
	await expect(again.getByLabel("Recovery code")).toHaveAccessibleDescription(
		/That code is not right/,
	);
	await expect(again).toHaveURL(/\/second-factor$/);
	await again.context().close();
});
