import * as crypto from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import {
	expectNoViolations,
	lockSharedState,
	loginAs,
	query,
	SETTINGS_ROW_LOCK,
	toast,
} from "./helpers";
import { findMailLink } from "./mail";

/**
 * Account email an administrator sends from the Users view, and editing a
 * Dex user's email or username (SPEC.md sections 5.1 and 5.3). Mail is
 * caught in MAIL_CAPTURE_FILE. These tests turn the one site-wide switch
 * on, so they hold the settings lock and run one after another.
 */
test.describe.configure({ mode: "serial" });

let release: (() => Promise<void>) | undefined;

async function setAccountEmail(on: boolean): Promise<void> {
	await query("update settings set account_email_enabled = $1 where id = 1", [on]);
}

test.beforeAll(async () => {
	// The wait for other workers' settings tests counts against this hook.
	test.setTimeout(600_000);
	release = await lockSharedState(SETTINGS_ROW_LOCK);
	await setAccountEmail(true);
});

test.afterAll(async () => {
	await setAccountEmail(false);
	await release?.();
});

async function openUsers(page: Page): Promise<void> {
	await loginAs(page, "carol");
	await page.goto("/admin");
	await expect(page.getByTestId("admin-accounts")).toBeVisible({ timeout: 15_000 });
}

function person() {
	const suffix = crypto.randomUUID().slice(0, 8);
	const username = `mail-${suffix}`;
	return { name: `Mail Person ${suffix}`, username, email: `${username}@example.edu` };
}

/** Add a Dex user with the emailed link ticked; returns who, and their account id. */
async function addWithLink(page: Page, options: { checkA11y?: boolean } = {}) {
	const who = person();
	await page.getByRole("button", { name: "Add user…" }).click();
	const form = page.getByRole("dialog", { name: "Add user" });
	await form.getByLabel("Name", { exact: true }).fill(who.name);
	await form.getByLabel("Email", { exact: true }).fill(who.email);
	await form.getByLabel("Username").fill(who.username);
	await form
		.getByRole("checkbox", { name: "Email them a link to choose their password" })
		.check();
	if (options.checkA11y) await expectNoViolations(page, "[data-testid=dex-add-dialog]");
	await form.getByRole("button", { name: "Add user" }).click();
	const done = page.getByRole("dialog", { name: `${who.name} added` });
	await expect(done).toContainText(
		"They were emailed a link to choose their password.",
	);
	await expect(done.getByTestId("dex-password")).toHaveCount(0);
	if (options.checkA11y) await expectNoViolations(page, "[data-testid=dex-add-dialog]");
	await done.getByRole("button", { name: "Done" }).click();
	const [row] = await query<{ id: string; oidc_subject: string }>(
		"select id, oidc_subject from users where email = $1",
		[who.email],
	);
	if (!row) throw new Error("the account was not pre-created");
	return { ...who, id: row.id, subject: row.oidc_subject };
}

async function openDetail(page: Page, name: string) {
	await page.getByTestId("admin-filter-text").fill(name);
	await page.getByRole("button", { name: `Show details for ${name}` }).click();
	return page.getByRole("region", { name });
}

test("Add user emails a link to choose a password instead of showing one", async ({
	page,
}) => {
	await openUsers(page);
	const added = await addWithLink(page, { checkA11y: true });
	const link = await findMailLink(added.email);
	expect(link).toMatch(/\/reset-password#[A-Za-z0-9_-]{43}$/);
	const [token] = await query<{ purpose: string }>(
		"select purpose from account_email_tokens where user_id = $1",
		[added.id],
	);
	expect(token?.purpose).toBe("invite");
});

test("Send reset link asks first, then emails a new link", async ({ page }) => {
	await openUsers(page);
	const added = await addWithLink(page);
	const invite = await findMailLink(added.email);
	const panel = await openDetail(page, added.name);
	await panel
		.getByRole("button", { name: `Send a reset link to ${added.name}` })
		.click();
	const dialog = page.getByRole("alertdialog", {
		name: `Email ${added.name} a reset link?`,
	});
	await expect(dialog).toContainText("lasts 30");
	await expectNoViolations(page, "[data-testid=dex-send-reset-dialog]");
	await dialog.getByRole("button", { name: "Send reset link" }).click();
	await expect(toast(page, `Reset link sent to ${added.name}`)).toBeVisible();
	await expect.poll(() => findMailLink(added.email)).not.toBe(invite);
});

test("a new email keeps the account, emails the new address, and tells the old one", async ({
	page,
}) => {
	await openUsers(page);
	const added = await addWithLink(page);
	const panel = await openDetail(page, added.name);
	await panel
		.getByRole("button", { name: `Edit email or username for ${added.name}` })
		.click();
	const dialog = page.getByRole("dialog", { name: `Edit ${added.name}` });
	await expect(dialog.getByLabel("Email")).toHaveValue(added.email);
	await expectNoViolations(page, "[data-testid=dex-edit-dialog]");
	const moved = `moved-${added.username}@example.edu`;
	await dialog.getByLabel("Email").fill(moved);
	await dialog.getByRole("button", { name: "Save" }).click();
	await expect(
		toast(page, "A link to choose a password went to the new address"),
	).toBeVisible();
	expect(await findMailLink(moved)).toMatch(/\/reset-password#/);
	// The same account row, keyed by the same Dex subject.
	const [row] = await query<{ id: string; oidc_subject: string; email: string }>(
		"select id, oidc_subject, email from users where id = $1",
		[added.id],
	);
	expect(row).toEqual({ id: added.id, oidc_subject: added.subject, email: moved });
	const audits = await query<{ metadata: unknown }>(
		"select metadata from audit_events where target = $1 and action = 'dex_user.updated'",
		[added.id],
	);
	expect(JSON.stringify(audits)).not.toContain("example.edu");
});

test("a new username alone keeps the password and needs no email", async ({ page }) => {
	await openUsers(page);
	const added = await addWithLink(page);
	const panel = await openDetail(page, added.name);
	await panel
		.getByRole("button", { name: `Edit email or username for ${added.name}` })
		.click();
	const dialog = page.getByRole("dialog", { name: `Edit ${added.name}` });
	await dialog.getByLabel("Username").fill(`${added.username}-2`);
	await dialog.getByRole("button", { name: "Save" }).click();
	await expect(toast(page, `${added.name}'s username changed`)).toBeVisible();
	const [row] = await query<{ preferred_username: string; email: string }>(
		"select preferred_username, email from users where id = $1",
		[added.id],
	);
	expect(row).toEqual({
		preferred_username: `${added.username}-2`,
		email: added.email,
	});
});

test("with account email off, a new email shows the new password once", async ({
	page,
}) => {
	await openUsers(page);
	const added = await addWithLink(page);
	await setAccountEmail(false);
	try {
		await page.reload();
		await expect(page.getByTestId("admin-accounts")).toBeVisible({ timeout: 15_000 });
		const panel = await openDetail(page, added.name);
		await expect(
			panel.getByRole("button", { name: `Send a reset link to ${added.name}` }),
		).toHaveCount(0);
		await panel
			.getByRole("button", { name: `Edit email or username for ${added.name}` })
			.click();
		const dialog = page.getByRole("dialog", { name: `Edit ${added.name}` });
		await dialog.getByLabel("Email").fill(`off-${added.username}@example.edu`);
		await dialog.getByRole("button", { name: "Save" }).click();
		const done = page.getByRole("dialog", { name: `New password for ${added.name}` });
		await expect(done.getByTestId("dex-password")).toHaveText(/^[A-Za-z0-9]{20}$/);
		await expectNoViolations(page, "[data-testid=dex-edit-dialog]");
	} finally {
		await setAccountEmail(true);
	}
});

test("Invite emails the invitation when ticked, and Resend sends it again", async ({
	page,
}) => {
	await openUsers(page);
	const who = person();
	await page.getByRole("button", { name: "Invite…" }).click();
	const dialog = page.getByRole("dialog", { name: "Invite someone" });
	await dialog.getByLabel("Name", { exact: true }).fill(who.name);
	await dialog.getByLabel("Email", { exact: true }).fill(who.email);
	await dialog.getByRole("checkbox", { name: "Email the invitation" }).check();
	await expectNoViolations(page, "[data-testid=invite-dialog]");
	await dialog.getByRole("button", { name: "Invite" }).click();
	await expect(toast(page, `${who.name} invited by email`)).toBeVisible();
	const link = await findMailLink(who.email);
	expect(link).not.toContain("#");

	await page.getByTestId("admin-filter-text").fill(who.name);
	await page
		.getByRole("button", { name: `Resend the invitation email to ${who.name}` })
		.click();
	await expect(toast(page, `Invitation for ${who.name} sent again`)).toBeVisible();
});

test("CSV import emails each person when ticked", async ({ page }) => {
	await openUsers(page);
	const pat = person();
	const quinn = person();
	const csv = [
		"name,email,username,role,kind",
		`${pat.name},${pat.email},${pat.username},student,password`,
		`${quinn.name},${quinn.email},,student,invite`,
	].join("\n");
	await page.getByRole("button", { name: "Import from CSV…" }).click();
	const dialog = page.getByRole("dialog", { name: "Import from CSV" });
	await dialog.getByRole("checkbox", { name: "Email each person" }).check();
	await dialog.getByLabel("CSV file").setInputFiles({
		name: "people.csv",
		mimeType: "text/csv",
		buffer: Buffer.from(csv),
	});
	await dialog.getByRole("button", { name: "Add 2 accounts" }).click();
	const done = page.getByRole("dialog", { name: "Import finished" });
	await expect(done.getByTestId("import-emailed")).toHaveText("2 people were emailed.");
	await expect(done.getByRole("button", { name: "Download passwords" })).toHaveCount(0);
	expect(await findMailLink(pat.email)).toMatch(/\/reset-password#/);
	expect(await findMailLink(quinn.email)).not.toContain("#");
});
