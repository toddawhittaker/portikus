import * as crypto from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import { loginAs, query, settledAxe, WEB_ORIGIN } from "./helpers";

/**
 * Add, reset and remove Dex users from the Users view (docs/archive/epics/EPIC-14.md
 * rulings 21, 22 and 24), against the fake Dex gRPC API the e2e environment
 * runs (e2e/fake-dex-grpc.mjs). Every test adds its own user.
 */

async function expectNoViolations(page: Page, selector: string) {
	const results = await (await settledAxe(page))
		.withTags(["wcag2a", "wcag2aa", "wcag21aa"])
		.include(selector)
		.analyze();
	expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
}

async function openUsers(page: Page): Promise<void> {
	await loginAs(page, "carol");
	await page.goto("/admin");
	await expect(page.getByTestId("admin-accounts")).toBeVisible({ timeout: 15_000 });
}

/** Add a user through the dialog; returns the name, the account id and the password. */
async function addUser(
	page: Page,
	role: "student" | "instructor" | "administrator" = "student",
	options: { checkA11y?: boolean } = {},
) {
	const username = `dex-${crypto.randomUUID().slice(0, 8)}`;
	const email = `${username}@example.edu`;
	await page.getByRole("button", { name: "Add user…" }).click();
	const form = page.getByRole("dialog", { name: "Add user" });
	await expect(form).toBeVisible();
	await form.getByLabel("Email").fill(email);
	await form.getByLabel("Username").fill(username);
	await form.getByLabel("Role").selectOption(role);
	if (options.checkA11y) await expectNoViolations(page, "[data-testid=dex-add-dialog]");
	await form.getByRole("button", { name: "Add user" }).click();

	const done = page.getByRole("dialog", { name: `${username} added` });
	await expect(done).toBeVisible();
	await expect(done).toContainText(
		"Give this to them privately. It will not be shown again.",
	);
	const password = (await done.getByTestId("dex-password").textContent()) ?? "";
	expect(password).toMatch(/^[A-Za-z0-9]{20}$/);
	if (options.checkA11y) await expectNoViolations(page, "[data-testid=dex-add-dialog]");
	await done.getByRole("button", { name: "Done" }).click();
	await expect(done).toBeHidden();

	const [row] = await query<{ id: string; granted_role: string | null; role: string }>(
		"select id, granted_role, role from users where email = $1",
		[email],
	);
	if (!row) throw new Error("the account was not pre-created");
	return { username, email, password, id: row.id, row };
}

async function openDetail(page: Page, name: string) {
	await page.getByTestId("admin-filter-text").fill(name);
	await page.getByRole("button", { name: `Show details for ${name}` }).click();
	return page.getByRole("region", { name });
}

test("Add user shows the password once and pre-creates the account", async ({
	page,
}) => {
	await openUsers(page);
	const add = page.getByRole("button", { name: "Add user…" });
	const added = await addUser(page, "instructor", { checkA11y: true });
	await expect(add).toBeFocused();
	expect(added.row).toMatchObject({ role: "instructor", granted_role: "instructor" });

	// The password is nowhere on the page once the dialog is gone.
	await expect(page.getByText(added.password)).toHaveCount(0);
	await page.getByTestId("admin-filter-text").fill(added.username);
	await expect(page.getByTestId(`account-role-${added.id}`)).toHaveText(
		"Instructor (granted)",
	);

	// Nothing Portikus stored carries the password.
	const audits = await query<{ metadata: unknown }>(
		"select metadata from audit_events where target = $1",
		[added.id],
	);
	expect(JSON.stringify(audits)).not.toContain(added.password);
	expect(JSON.stringify(audits)).not.toContain(added.email);
});

/** Submit an empty Add user form and check its field errors. */
async function submitEmptyAdd(page: Page): Promise<void> {
	await page.getByRole("button", { name: "Add user…" }).click();
	const form = page.getByRole("dialog", { name: "Add user" });
	await form.getByRole("button", { name: "Add user" }).click();
	await expect(form.getByLabel("Email")).toBeFocused();
	await expect(form.getByLabel("Email")).toHaveAccessibleDescription(
		"Enter an email address.",
	);
	await expectNoViolations(page, "[data-testid=dex-add-dialog]");
}

test("Add user field errors sit on their fields, in light and dark", async ({
	page,
}) => {
	await openUsers(page);
	await submitEmptyAdd(page);

	// Reloaded rather than switched in place, so no colour transition is caught midway.
	await page.emulateMedia({ colorScheme: "dark" });
	await page.reload();
	await expect(page.getByTestId("admin-accounts")).toBeVisible({ timeout: 15_000 });
	await submitEmptyAdd(page);
});

test("a taken email is refused in the dialog", async ({ page }) => {
	await openUsers(page);
	const added = await addUser(page);
	await page.getByRole("button", { name: "Add user…" }).click();
	const form = page.getByRole("dialog", { name: "Add user" });
	await form.getByLabel("Email").fill(added.email);
	await form.getByLabel("Username").fill(`${added.username}x`);
	await form.getByRole("button", { name: "Add user" }).click();
	await expect(form.getByRole("alert")).toHaveText(
		"A Dex user with this email already exists.",
	);
});

test("Reset password shows a new password once and signs the user out", async ({
	page,
}) => {
	await openUsers(page);
	const added = await addUser(page);
	await query(
		`insert into sessions (id, user_id, expires_at, method)
		 values ($1, $2, now() + interval '1 hour', 'oidc')`,
		[crypto.randomBytes(32).toString("hex"), added.id],
	);
	const panel = await openDetail(page, added.username);
	const reset = panel.getByRole("button", {
		name: `Reset password for ${added.username}`,
	});
	await reset.click();
	const dialog = page.getByRole("dialog", {
		name: `Reset the password for ${added.username}?`,
	});
	await expect(dialog).toBeVisible();
	await expectNoViolations(page, "[data-testid=dex-reset-dialog]");
	await dialog.getByRole("button", { name: "Reset password" }).click();

	const shown = page.getByRole("dialog", {
		name: `New password for ${added.username}`,
	});
	const password = (await shown.getByTestId("dex-password").textContent()) ?? "";
	expect(password).toMatch(/^[A-Za-z0-9]{20}$/);
	expect(password).not.toBe(added.password);
	await expectNoViolations(page, "[data-testid=dex-reset-dialog]");
	await shown.getByRole("button", { name: "Done" }).click();
	await expect(shown).toBeHidden();
	await expect(reset).toBeFocused();

	const sessions = await query("select id from sessions where user_id = $1", [
		added.id,
	]);
	expect(sessions).toEqual([]);
});

test("Remove deletes the Dex user and disables the account", async ({ page }) => {
	await openUsers(page);
	const added = await addUser(page);
	const panel = await openDetail(page, added.username);
	await panel.getByRole("button", { name: `Remove user ${added.username}` }).click();
	const dialog = page.getByRole("alertdialog", { name: `Remove ${added.username}?` });
	await expect(dialog).toContainText("The workspace stays for you to archive.");
	await expectNoViolations(page, "[data-testid=dex-remove-dialog]");
	await dialog.getByRole("button", { name: "Remove" }).click();
	await expect(dialog).toBeHidden();

	// The Dex buttons are gone, so focus lands on the panel heading.
	await expect(panel.getByRole("button", { name: /^Remove user/ })).toHaveCount(0);
	await expect(panel.getByRole("heading", { name: added.username })).toBeFocused();
	await expect(panel.getByRole("button", { name: /^Enable account/ })).toBeVisible();
	const [row] = await query<{ disabled_at: Date | null }>(
		"select disabled_at from users where id = $1",
		[added.id],
	);
	expect(row?.disabled_at).not.toBeNull();

	// Removing again finds no Dex password.
	const again = await page.request.post(`/admin/dex-users/${added.id}/remove`, {
		headers: { origin: WEB_ORIGIN },
	});
	expect(again.status()).toBe(400);
	expect((await again.json()).message).toBe("This account has no Dex password.");
});

test("an SSO account has no Dex buttons", async ({ page }) => {
	await openUsers(page);
	const carol = await openDetail(page, "Carol Admin");
	await expect(carol.getByRole("button", { name: /^Reset password/ })).toHaveCount(0);
	await expect(carol.getByRole("button", { name: /^Remove user/ })).toHaveCount(0);
});
