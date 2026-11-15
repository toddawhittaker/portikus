import { randomUUID } from "node:crypto";
import { expect, type Locator, type Page, test } from "@playwright/test";
import {
	createLocalPasswordAdmin,
	createStudent,
	loginAs,
	query,
	TestAuthenticator,
	workspacePath,
} from "./helpers";

/**
 * Settings, API keys (SPEC.md sections 24.8 and 24.13): an administrator or
 * instructor creates a key and sees its secret once, renews it with the same
 * secret or a new one, and revokes it for good. Students never see the pane.
 * Carol signs in through the mock SSO provider, so she gets 30-day keys only;
 * a Dex local-password account chooses a period and proves its second factor.
 */

async function openKeys(page: Page): Promise<Locator> {
	await page.getByTestId("me").click();
	await page.getByRole("menuitem", { name: "Settings" }).click();
	const dialog = page.getByTestId("dialog-editor-settings");
	await dialog.getByRole("button", { name: "API keys", exact: true }).click();
	await expect(dialog.getByRole("heading", { name: "Your API keys" })).toBeVisible();
	return dialog;
}

async function carolKeys(page: Page): Promise<Locator> {
	await loginAs(page, "carol");
	await page.goto("/admin");
	await expect(page.getByTestId("admin-accounts")).toBeVisible({ timeout: 15_000 });
	return openKeys(page);
}

/** Create a key with Carol's fixed period and return its name and secret. */
async function createKey(dialog: Locator, name: string): Promise<string> {
	await dialog.getByRole("button", { name: "Create an API key" }).click();
	await dialog.getByLabel("Name").fill(name);
	await dialog.getByTestId("api-key-create-submit").click();
	const secret = (await dialog.getByTestId("api-key-secret-value").textContent()) ?? "";
	await dialog.getByTestId("api-key-secret-done").click();
	return secret;
}

function keyRow(dialog: Locator, name: string): Locator {
	return dialog.getByRole("listitem").filter({ hasText: name });
}

async function storedHash(name: string): Promise<string> {
	const [row] = await query<{ token_hash: string }>(
		"select token_hash from api_keys where name = $1",
		[name],
	);
	if (!row) throw new Error(`no key named ${name}`);
	return row.token_hash;
}

test("creating a key shows its secret once, with a Claude Code command", async ({
	page,
}) => {
	const dialog = await carolKeys(page);
	const name = `Claude ${randomUUID().slice(0, 8)}`;
	await dialog.getByRole("button", { name: "Create an API key" }).click();
	// An SSO account is told its period rather than offered a choice.
	await expect(dialog.getByTestId("api-key-period-fixed")).toContainText("30 days");
	await expect(dialog.getByRole("group", { name: "Expires after" })).toHaveCount(0);
	// Read is the default access; each scope says what it allows.
	await expect(dialog.getByRole("radio", { name: /^Read/ })).toBeChecked();
	await expect(
		dialog.getByRole("radio", { name: /^Destructive/ }),
	).toHaveAccessibleDescription(/cannot be undone/);
	await dialog.getByLabel("Name").fill(name);
	await dialog.getByTestId("api-key-create-submit").click();

	await expect(
		dialog.getByRole("heading", { name: `Copy the secret for ${name}` }),
	).toBeFocused();
	const secret = (await dialog.getByTestId("api-key-secret-value").textContent()) ?? "";
	expect(secret).toMatch(/^portikus_/);
	await expect(dialog.getByTestId("api-key-secret")).toContainText(
		"This is the only time Portikus shows it.",
	);
	await expect(dialog.getByTestId("api-key-claude-command")).toHaveText(
		`claude mcp add --transport http portikus ${new URL(page.url()).origin}/mcp --header "Authorization: Bearer ${secret}"`,
	);
	// Only a hash is stored.
	expect(await storedHash(name)).not.toContain(secret);

	await dialog.getByTestId("api-key-secret-done").click();
	await expect(dialog.getByTestId("api-key-secret")).toHaveCount(0);
	const row = keyRow(dialog, name);
	await expect(row.getByTestId("api-key-state")).toHaveText("Active");
	await expect(row).toContainText("Never used");
	await expect(row).toContainText(secret.slice(0, 12));

	// Opening Settings again never shows the secret.
	await page.reload();
	await expect(page.getByTestId("admin-accounts")).toBeVisible({ timeout: 15_000 });
	const again = await openKeys(page);
	await expect(keyRow(again, name)).toBeVisible();
	await expect(page.locator("body")).not.toContainText(secret);
});

test("an expired key renews with the same secret", async ({ page }) => {
	const dialog = await carolKeys(page);
	const name = `Renew ${randomUUID().slice(0, 8)}`;
	await createKey(dialog, name);
	const hash = await storedHash(name);
	await query(
		"update api_keys set expires_at = now() - interval '1 day' where name = $1",
		[name],
	);
	await page.reload();
	await expect(page.getByTestId("admin-accounts")).toBeVisible({ timeout: 15_000 });
	const again = await openKeys(page);
	const row = keyRow(again, name);
	await expect(row.getByTestId("api-key-state")).toHaveText("Expired");

	await row.getByRole("button", { name: "Renew", exact: true }).click();
	await expect(again.getByTestId("api-keys-status")).toContainText(
		`${name} renewed. It now expires`,
	);
	await expect(row.getByTestId("api-key-state")).toHaveText("Active");
	await expect(again.getByTestId("api-key-secret")).toHaveCount(0);
	expect(await storedHash(name)).toBe(hash);
});

test("renew with a new secret confirms with the prefix and last use, then shows the new secret", async ({
	page,
}) => {
	const dialog = await carolKeys(page);
	const name = `Rotate ${randomUUID().slice(0, 8)}`;
	const old = await createKey(dialog, name);
	const hash = await storedHash(name);
	const row = keyRow(dialog, name);

	await row.getByRole("button", { name: "Renew with a new secret…" }).click();
	const confirm = page.getByTestId("api-key-rotate-confirm");
	await expect(confirm).toContainText(old.slice(0, 12));
	await expect(confirm).toContainText("last used never");
	await expect(confirm).toContainText("old secret stops working");
	await confirm.getByRole("button", { name: "Renew with a new secret" }).click();

	const fresh = (await dialog.getByTestId("api-key-secret-value").textContent()) ?? "";
	expect(fresh).toMatch(/^portikus_/);
	expect(fresh).not.toBe(old);
	await expect(dialog.getByTestId("api-key-secret")).toContainText(
		"The old secret has stopped working.",
	);
	expect(await storedHash(name)).not.toBe(hash);
	await dialog.getByTestId("api-key-secret-done").click();
	await expect(row.getByRole("heading", { name })).toBeFocused();
});

test("a revoked key shows no way to renew it", async ({ page }) => {
	const dialog = await carolKeys(page);
	const name = `Revoke ${randomUUID().slice(0, 8)}`;
	await createKey(dialog, name);
	const row = keyRow(dialog, name);

	await row.getByRole("button", { name: "Revoke…" }).click();
	const confirm = page.getByTestId("api-key-revoke-confirm");
	await expect(confirm).toContainText("cannot be undone");
	await confirm.getByRole("button", { name: "Revoke key" }).click();

	await expect(row.getByTestId("api-key-state")).toHaveText("Revoked");
	await expect(row.getByRole("button")).toHaveCount(0);
	await expect(dialog.getByTestId("api-keys-status")).toHaveText(`${name} revoked.`);
	// Focus stays on the key rather than falling to the page.
	await expect(row.getByRole("heading", { name })).toBeFocused();
});

test("a student never sees API keys in Settings", async ({ page, context }) => {
	const student = await createStudent(context);
	await page.goto(workspacePath(student.workspaceId));
	await expect(page.getByTestId("me")).toBeVisible({ timeout: 15_000 });
	await page.getByTestId("me").click();
	await page.getByRole("menuitem", { name: "Settings" }).click();
	const dialog = page.getByTestId("dialog-editor-settings");
	await expect(dialog.getByRole("button", { name: "Preferences" })).toBeVisible();
	await expect(dialog.getByRole("button", { name: "API keys" })).toHaveCount(0);
	await dialog.getByLabel("Search").fill("API key");
	await expect(dialog.getByText("No matching settings.")).toBeVisible();
});

test("a Dex local-password account chooses a period and proves its second factor", async ({
	page,
	context,
}) => {
	await createLocalPasswordAdmin(context, {
		prefix: "api-keys-local",
		displayName: "Local Key Maker",
		mustChange: false,
	});
	await page.goto("/admin");
	await expect(page.getByTestId("admin-accounts")).toBeVisible({ timeout: 15_000 });

	// Give the account an authenticator app first, in Settings.
	await page.getByTestId("me").click();
	await page.getByRole("menuitem", { name: "Settings" }).click();
	const dialog = page.getByTestId("dialog-editor-settings");
	await dialog.getByRole("button", { name: "Two-factor sign-in" }).click();
	await dialog.getByRole("button", { name: "Add an authenticator app" }).click();
	const key = (await dialog.getByTestId("totp-secret").textContent()) ?? "";
	const app = TestAuthenticator.fromKey(key);
	await dialog.getByLabel("Code from your app").fill(await app.nextCode());
	await dialog.getByRole("button", { name: "Turn on two-step sign-in" }).click();
	await dialog.getByRole("button", { name: "I have saved them, continue" }).click();

	await dialog.getByRole("button", { name: "API keys", exact: true }).click();
	await dialog.getByRole("button", { name: "Create an API key" }).click();
	const periods = dialog.getByRole("group", { name: "Expires after" });
	await expect(periods.getByRole("radio")).toHaveCount(4);
	await expect(periods.getByRole("radio", { name: "30 days" })).toBeChecked();
	await periods.getByRole("radio", { name: "Never" }).check();
	const name = `Local ${randomUUID().slice(0, 8)}`;
	await dialog.getByLabel("Name").fill(name);

	// No code: refused at the field, and nothing is made.
	await dialog.getByTestId("api-key-create-submit").click();
	const code = dialog.getByLabel("Two-step sign-in code");
	await expect(code).toHaveAccessibleDescription(
		/Enter a code from your authenticator app/,
	);
	await code.fill(await app.nextCode());
	await dialog.getByTestId("api-key-create-submit").click();
	await expect(dialog.getByTestId("api-key-secret")).toBeVisible();
	await dialog.getByTestId("api-key-secret-done").click();
	await expect(keyRow(dialog, name).getByTestId("api-key-expiry")).toHaveText("Never");
});
