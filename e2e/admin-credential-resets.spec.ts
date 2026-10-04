import * as crypto from "node:crypto";
import { expect, test } from "@playwright/test";
import { dexLocalSubject } from "../packages/auth/dist/dex-subject.js";
import {
	addSession,
	enrolSecondFactor,
	expectNoViolations,
	MOCK_ISSUER,
	openAdmin,
	openDetail,
	query,
	WEB_ORIGIN,
} from "./helpers";

/**
 * An administrator resets a person's two-factor sign-in; the person is told
 * and must set up a new factor. The install administrator is protected from
 * other administrators (SPEC.md sections 5.1 and 24.13).
 */

const REFUSAL =
	"Only the install administrator can change the install administrator account. Recover it on the host with portikus reset-admin.";

test("an administrator resets a student's two-factor sign-in; the student sets up a new one and is told", async ({
	page,
	browser,
}) => {
	await openAdmin(page);
	// Add user makes a real Dex password in the fake Dex, so the reset finds one.
	const suffix = crypto.randomUUID().slice(0, 8);
	const name = `Reset Person ${suffix}`;
	const email = `reset-${suffix}@example.edu`;
	await page.getByRole("button", { name: "Add user…" }).click();
	const form = page.getByRole("dialog", { name: "Add user" });
	await form.getByLabel("Name", { exact: true }).fill(name);
	await form.getByLabel("Email").fill(email);
	await form.getByLabel("Username").fill(`reset-${suffix}`);
	await form.getByRole("button", { name: "Add user" }).click();
	await page
		.getByRole("dialog", { name: `${name} added` })
		.getByRole("button", { name: "Done" })
		.click();
	const [row] = await query<{ id: string }>("select id from users where email = $1", [
		email,
	]);
	if (!row) throw new Error("the account was not created");
	// As if they had chosen a password and set up an authenticator long ago.
	await query("update users set must_change_password = false where id = $1", [row.id]);
	await query(
		"insert into user_second_factors (user_id, kind, secret, label) values ($1, 'totp', 'old', 'Old phone')",
		[row.id],
	);

	const panel = await openDetail(page, name, "Account");
	await panel
		.getByRole("button", { name: `Reset two-factor sign-in for ${name}` })
		.click();
	const dialog = page.getByRole("alertdialog", {
		name: `Reset two-factor sign-in for ${name}?`,
	});
	await expect(dialog).toContainText(
		"They must set up a new second factor the next time they sign in.",
	);
	await expectNoViolations(page, "[data-testid=dex-factor-dialog]");
	await dialog.getByRole("button", { name: "Reset two-factor sign-in" }).click();
	await expect(dialog).toBeHidden();

	// The student's next sign-in: a new session meets the setup gate.
	const context = await browser.newContext();
	try {
		await addSession(context, row.id);
		const student = await context.newPage();
		await student.goto("/");
		await enrolSecondFactor(student);
		await expect(student.getByTestId("app-header")).toBeVisible({ timeout: 15_000 });
		await expect(student.getByTestId("notifications-badge")).toHaveText("1");
		await student.getByTestId("me").click();
		await student.getByRole("menuitem", { name: "Notifications" }).click();
		await expect(
			student.getByTestId("dialog-notifications").getByTestId("notification"),
		).toContainText("An administrator reset your two-factor sign-in on ");
	} finally {
		await context.close();
	}
});

test("another administrator is refused on the install administrator", async ({
	page,
}) => {
	// The install administrator's account, whatever another spec did with it.
	await query(
		`insert into users (oidc_issuer, oidc_subject, email, display_name, role, granted_role)
		 values ($1, $2, 'admin@example.edu', 'Local administrator', 'administrator', 'administrator')
		 on conflict do nothing`,
		[MOCK_ISSUER, dexLocalSubject("local-admin")],
	);
	await query(
		"update users set role = 'administrator', granted_role = 'administrator', disabled_at = null where oidc_subject = $1",
		[dexLocalSubject("local-admin")],
	);
	const [admin] = await query<{ id: string; display_name: string }>(
		"select id, display_name from users where oidc_issuer = $1 and oidc_subject = $2",
		[MOCK_ISSUER, dexLocalSubject("local-admin")],
	);
	if (!admin) throw new Error("no install administrator account");

	await openAdmin(page);
	const panel = await openDetail(page, admin.display_name, "Account");
	await panel.getByRole("button", { name: `Demote ${admin.display_name}` }).click();
	const demote = page.getByRole("alertdialog", {
		name: `Demote ${admin.display_name}?`,
	});
	await demote.getByRole("button", { name: "Demote" }).click();
	await expect(demote.getByRole("alert")).toHaveText(REFUSAL);

	for (const path of ["reset-password", "reset-second-factor"]) {
		const res = await page.request.post(`/admin/dex-users/${admin.id}/${path}`, {
			headers: { origin: WEB_ORIGIN },
		});
		expect(res.status()).toBe(403);
		expect((await res.json()).message).toBe(REFUSAL);
	}
	const [after] = await query<{ role: string }>(
		"select role from users where id = $1",
		[admin.id],
	);
	expect(after?.role).toBe("administrator");
});
