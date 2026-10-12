import * as crypto from "node:crypto";
import { expect, test } from "@playwright/test";
import {
	expectNoViolations,
	lockSharedState,
	loginAs,
	query,
	SETTINGS_ROW_LOCK,
	WEB_ORIGIN,
} from "./helpers";
import { clearMail, findMailLink } from "./mail";

/**
 * Forgotten password by email (SPEC.md section 5.3): ask on the forgot
 * page, open the emailed link, choose a password. The test turns account
 * email on in the one settings row, so it holds the lock every worker shares.
 */
test.describe.configure({ mode: "serial" });

let release: (() => Promise<void>) | undefined;

test.beforeAll(async () => {
	test.setTimeout(600_000);
	release = await lockSharedState(SETTINGS_ROW_LOCK);
	await query("update settings set account_email_enabled = true where id = 1");
});

test.afterAll(async () => {
	await query("update settings set account_email_enabled = false where id = 1");
	await release?.();
});

test("a forgotten password is reset through the emailed link", async ({
	page,
	browser,
}) => {
	// An administrator adds a Dex user, as on the Users view.
	await loginAs(page, "carol");
	const suffix = crypto.randomUUID().slice(0, 8);
	const email = `reset-${suffix}@example.edu`;
	const added = await page.request.post("/admin/dex-users", {
		headers: { origin: WEB_ORIGIN },
		data: {
			email,
			username: `reset-${suffix}`,
			name: `Reset ${suffix}`,
			role: "student",
		},
	});
	expect(added.status()).toBe(200);
	const userId = ((await added.json()) as { user: { id: string } }).user.id;
	await clearMail();
	// Every browser here shares one address; start this test's hour fresh (SPEC.md section 24.13).
	await query("delete from signin_counters where scope like 'reset-%'");

	// The person is signed out on their own browser.
	const context = await browser.newContext();
	const visitor = await context.newPage();
	await visitor.goto("/forgot-password");
	await expect(
		visitor.getByRole("heading", { name: "Forgot your password?" }),
	).toBeFocused();
	await expectNoViolations(visitor);
	await visitor.getByLabel("Email address").fill(email);
	await visitor.getByRole("button", { name: "Email me a link" }).click();
	await expect(visitor.getByRole("status")).toContainText(
		"If that address belongs to an account here, a link is on its way.",
	);

	const link = await findMailLink(email);
	expect(link).toMatch(/\/reset-password#[A-Za-z0-9_-]{43}$/);
	await visitor.goto(link);
	await expect(
		visitor.getByRole("heading", { name: "Choose a new password" }),
	).toBeVisible();
	// The token leaves the address bar at once.
	await expect.poll(() => new URL(visitor.url()).hash).toBe("");
	await expectNoViolations(visitor);

	await visitor.getByLabel("New password", { exact: true }).fill("short");
	await visitor.getByLabel("New password again").fill("short");
	await visitor.getByRole("button", { name: "Save new password" }).click();
	await expect(visitor.getByLabel("New password", { exact: true })).toBeFocused();

	const password = `a long new password ${suffix}`;
	await visitor.getByLabel("New password", { exact: true }).fill(password);
	await visitor.getByLabel("New password again").fill(password);
	await visitor.getByRole("button", { name: "Save new password" }).click();
	await expect(
		visitor.getByRole("heading", { name: "Your password was changed" }),
	).toBeFocused();
	await expectNoViolations(visitor);

	const [row] = await query<{ must_change_password: boolean }>(
		"select must_change_password from users where id = $1",
		[userId],
	);
	expect(row?.must_change_password).toBe(false);
	const audits = await query<{ metadata: Record<string, unknown> }>(
		"select metadata from audit_events where action = 'user.password_reset_by_email' and target = $1",
		[userId],
	);
	expect(audits).toHaveLength(1);
	expect(JSON.stringify(audits)).not.toContain(link.split("#")[1] ?? "-");

	// The same link does not work twice. Leave first: a change of fragment alone would not reload.
	await visitor.goto("about:blank");
	await visitor.goto(link);
	await visitor.getByLabel("New password", { exact: true }).fill(password);
	await visitor.getByLabel("New password again").fill(password);
	await visitor.getByRole("button", { name: "Save new password" }).click();
	await expect(visitor.getByRole("alert")).toContainText("expired or was already used");
	await expect(visitor.getByRole("link", { name: "Ask for a new link" })).toBeVisible();
	await context.close();
});

test("a link page opened without its token says so", async ({ page }) => {
	await page.goto("/reset-password");
	await expect(
		page.getByRole("heading", { name: "This link is incomplete" }),
	).toBeVisible();
	await expectNoViolations(page);
});
