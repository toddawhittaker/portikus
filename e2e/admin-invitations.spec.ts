import * as crypto from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import { loginAs, MOCK_ISSUER, query } from "./helpers";

/**
 * Nobody signs themselves up: an SSO account is made only by claiming an
 * administrator's invitation (SPEC.md section 24.13).
 */

async function openUsers(page: Page): Promise<void> {
	await loginAs(page, "carol");
	await page.goto("/admin");
	await expect(page.getByTestId("admin-accounts")).toBeVisible({ timeout: 15_000 });
}

async function invite(
	page: Page,
	person: { name: string; email: string; role: "student" | "instructor" },
): Promise<void> {
	await page.getByRole("button", { name: "Invite…" }).click();
	const dialog = page.getByRole("dialog", { name: "Invite someone" });
	await dialog.getByLabel("Name", { exact: true }).fill(person.name);
	await dialog.getByLabel("Email").fill(person.email);
	await dialog.getByLabel("Role").selectOption(person.role);
	await dialog.getByRole("button", { name: "Invite" }).click();
	await expect(dialog).toBeHidden();
}

test("an invited person signs in with the role the invitation gave", async ({
	page,
	browser,
}) => {
	// A retry starts clean: the earlier attempt's account keeps its rows under another subject.
	await query("delete from account_invitations where email = 'nina@example.edu'");
	await query(
		"update users set oidc_subject = $1 where oidc_issuer = $2 and oidc_subject = 'nina'",
		[`nina-earlier-${crypto.randomUUID()}`, MOCK_ISSUER],
	);

	await openUsers(page);
	await invite(page, {
		name: "Nina Newcomer",
		email: "nina@example.edu",
		role: "instructor",
	});
	const row = page.getByTestId("invitation-nina@example.edu");
	await expect(row.getByText("Invited")).toBeVisible();

	const context = await browser.newContext();
	try {
		const nina = await context.newPage();
		await loginAs(nina, "nina");
		const me = await nina.request.get("/auth/me");
		expect(me.ok()).toBe(true);
		expect((await me.json()).role).toBe("instructor");
	} finally {
		await context.close();
	}

	// Claimed, so it no longer waits.
	await page.reload();
	await expect(page.getByTestId("admin-accounts")).toBeVisible({ timeout: 15_000 });
	await expect(page.getByTestId("invitation-nina@example.edu")).toHaveCount(0);
});

test("someone uninvited is told to ask for an invitation", async ({ page }) => {
	await loginAs(page, "frank");
	await expect(page).toHaveURL(/\/not-invited$/);
	await expect(
		page.getByRole("heading", {
			name: "Your account has not been set up on this site",
		}),
	).toBeVisible();
	await expect(page.getByText("Ask your administrator to invite you.")).toBeVisible();
	const me = await page.request.get("/auth/me");
	expect(me.status()).toBe(401);
});

test("an administrator revokes a waiting invitation", async ({ page }) => {
	const tag = crypto.randomUUID().slice(0, 8);
	const email = `invitee-${tag}@example.edu`;
	await openUsers(page);
	await invite(page, { name: `Invitee ${tag}`, email, role: "student" });
	const row = page.getByTestId(`invitation-${email}`);
	await expect(row).toBeVisible();

	await row
		.getByRole("button", { name: `Revoke the invitation for Invitee ${tag}` })
		.click();
	const confirm = page.getByRole("alertdialog", {
		name: `Revoke the invitation for Invitee ${tag}?`,
	});
	await confirm.getByRole("button", { name: "Revoke" }).click();
	await expect(row).toHaveCount(0);
	const [stored] = await query<{ revoked: boolean }>(
		"select revoked_at is not null as revoked from account_invitations where email = $1",
		[email],
	);
	expect(stored?.revoked).toBe(true);
});
