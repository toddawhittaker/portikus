import { type Browser, expect, type Page, test } from "@playwright/test";
import { addSession, createLocalPasswordAdmin, TestAuthenticator } from "./helpers";
import { WEB_ORIGIN } from "./ports";
import { SoftPasskey, useSoftPasskey } from "./soft-passkey";

/**
 * Settings, Two-factor sign-in, and passkeys (SPEC.md section 24.13). Each
 * test makes its own Dex local-password account whose first session has
 * passed the check; a new session for the same account plays a later
 * sign-in, which must pass the gate again.
 */

async function openTwoFactor(page: Page) {
	await page.goto("/admin");
	await expect(page.getByTestId("admin-accounts")).toBeVisible({ timeout: 15_000 });
	await page.getByTestId("me").click();
	await page.getByRole("menuitem", { name: "Settings" }).click();
	const dialog = page.getByTestId("dialog-editor-settings");
	await dialog.getByRole("button", { name: "Two-factor sign-in" }).click();
	await expect(
		dialog.getByRole("heading", { name: "Your sign-in methods" }),
	).toBeVisible();
	return dialog;
}

/** Read the recovery codes shown once, then continue past them. */
async function takeCodes(page: Page): Promise<string[]> {
	const list = page.getByTestId("recovery-codes");
	await expect(list).toBeVisible();
	const codes = await list.getByRole("listitem").allTextContents();
	await page.getByRole("button", { name: "I have saved them, continue" }).click();
	await expect(list).toBeHidden();
	return codes;
}

/** A later sign-in of the same account, stopped at the gate. */
async function laterSignIn(
	browser: Browser,
	userId: string,
	key?: SoftPasskey,
): Promise<Page> {
	const context = await browser.newContext({ baseURL: WEB_ORIGIN });
	if (key) await useSoftPasskey(context, key);
	await addSession(context, userId);
	const page = await context.newPage();
	await page.goto("/admin");
	await expect(page).toHaveURL(/\/second-factor$/, { timeout: 15_000 });
	await expect(page.getByRole("heading", { name: "Two-step sign-in" })).toBeVisible();
	return page;
}

async function newAccount(page: Page, prefix: string): Promise<string> {
	return createLocalPasswordAdmin(page.context(), {
		prefix,
		displayName: "Two Factor Settings",
		mustChange: false,
	});
}

test("a passkey added in Settings signs a later session in at the gate", async ({
	page,
	browser,
}) => {
	const key = new SoftPasskey(WEB_ORIGIN);
	await useSoftPasskey(page.context(), key);
	const userId = await newAccount(page, "passkey-settings");
	const dialog = await openTwoFactor(page);
	await dialog.getByRole("button", { name: "Add a passkey" }).click();
	await expect(
		dialog.getByRole("heading", { name: "Your new recovery codes" }),
	).toBeFocused();
	expect(await takeCodes(page)).toHaveLength(10);
	await expect(dialog.getByTestId("factor-webauthn")).toContainText("Passkey");

	// Sign out, then sign in again: the gate offers the passkey.
	await page.getByTestId("settings-close").click();
	await page.context().clearCookies();
	const later = await laterSignIn(browser, userId, key);
	await later.getByRole("button", { name: "Use a passkey" }).click();
	await expect(later).not.toHaveURL(/\/second-factor$/, { timeout: 15_000 });
	await expect(later.getByTestId("admin-accounts")).toBeVisible({ timeout: 15_000 });

	// A copied key that reports an old sign count is refused.
	key.counter = 0;
	const copy = await laterSignIn(browser, userId, key);
	await copy.getByRole("button", { name: "Use a passkey" }).click();
	await expect(copy.getByRole("alert")).toContainText("That passkey did not work.");
	await expect(copy).toHaveURL(/\/second-factor$/);
	await later.context().close();
	await copy.context().close();
});

test("the setup page offers a passkey beside the authenticator app", async ({
	page,
}) => {
	await useSoftPasskey(page.context(), new SoftPasskey(WEB_ORIGIN));
	const userId = await newAccount(page, "passkey-setup");
	await page.context().clearCookies();
	await addSession(page.context(), userId);
	await page.goto("/admin");
	await expect(
		page.getByRole("heading", { name: "Set up two-step sign-in" }),
	).toBeVisible({
		timeout: 15_000,
	});
	await page.getByRole("button", { name: "Use a passkey" }).click();
	await expect(
		page.getByRole("heading", { name: "Save your recovery codes" }),
	).toBeVisible();
	await page.getByRole("button", { name: "I have saved them, continue" }).click();
	await expect(page.getByTestId("admin-accounts")).toBeVisible({ timeout: 15_000 });
});

test("an authenticator app is added and removed; the last one is never removed", async ({
	page,
}) => {
	await useSoftPasskey(page.context(), new SoftPasskey(WEB_ORIGIN));
	await newAccount(page, "totp-settings");
	const dialog = await openTwoFactor(page);

	await dialog.getByRole("button", { name: "Add an authenticator app" }).click();
	const secret = (await dialog.getByTestId("totp-secret").textContent()) ?? "";
	const app = TestAuthenticator.fromKey(secret);
	await dialog.getByLabel("Code from your app").fill(await app.nextCode());
	await dialog.getByRole("button", { name: "Turn on two-step sign-in" }).click();
	await takeCodes(page);
	await expect(dialog.getByTestId("factor-totp")).toContainText("Authenticator app");

	// The only factor stays, and the dialog says why.
	await dialog.getByRole("button", { name: "Remove Authenticator app" }).click();
	await expect(dialog.getByTestId("factor-remove-error")).toHaveText(
		"Add another way to sign in before you remove this one.",
	);
	await expect(dialog.getByTestId("factor-totp")).toBeVisible();

	// With a passkey beside it, the app can go.
	await dialog.getByRole("button", { name: "Add a passkey" }).click();
	await takeCodes(page);
	await dialog.getByRole("button", { name: "Remove Authenticator app" }).click();
	await expect(dialog.getByTestId("factor-totp")).toHaveCount(0);
	await expect(dialog.getByTestId("factor-webauthn")).toBeVisible();

	// Rename what is left.
	await dialog.getByRole("button", { name: "Rename Passkey" }).click();
	await dialog.getByLabel("Name").fill("Work laptop");
	await dialog.getByRole("button", { name: "Save name" }).click();
	await expect(dialog.getByTestId("factor-webauthn")).toContainText("Work laptop");
	await expect(
		dialog.getByRole("button", { name: "Rename Work laptop" }),
	).toBeFocused();
});

test("new recovery codes replace the old ones", async ({ page, browser }) => {
	await useSoftPasskey(page.context(), new SoftPasskey(WEB_ORIGIN));
	const userId = await newAccount(page, "recovery-settings");
	const dialog = await openTwoFactor(page);
	await dialog.getByRole("button", { name: "Add a passkey" }).click();
	const old = await takeCodes(page);
	await expect(dialog.getByTestId("recovery-codes-left")).toContainText(
		"10 unused recovery codes left.",
	);

	await dialog.getByRole("button", { name: "Make new recovery codes" }).click();
	await expect(
		dialog.getByRole("heading", { name: "Your new recovery codes" }),
	).toBeFocused();
	const fresh = await takeCodes(page);
	expect(fresh).toHaveLength(10);
	expect(fresh).not.toContain(old[0]);

	const later = await laterSignIn(browser, userId);
	await later.getByRole("button", { name: "Use a recovery code" }).click();
	await later.getByLabel("Recovery code").fill(old[0] as string);
	await later.getByRole("button", { name: "Continue" }).click();
	await expect(later.getByLabel("Recovery code")).toHaveAccessibleDescription(
		/That code is not right/,
	);
	await later.getByLabel("Recovery code").fill(fresh[0] as string);
	await later.getByRole("button", { name: "Continue" }).click();
	await expect(later).not.toHaveURL(/\/second-factor$/, { timeout: 15_000 });
	await later.context().close();
});
