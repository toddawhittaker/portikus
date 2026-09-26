import * as crypto from "node:crypto";
import { type BrowserContext, expect, test } from "@playwright/test";
import { dexLocalSubject } from "../packages/auth/dist/dex-subject.js";
import { createStudent, MOCK_ISSUER, query, WEB_ORIGIN } from "./helpers";

/**
 * The acceptable-use gate (docs/EPIC-14-3.md rulings 29 to 33). The run's
 * users have accepted already (packages/db testing), so each test makes its
 * own account and clears that. The statement's version is never bumped
 * here: that would send every other spec running alongside to the gate. A
 * stale acceptance stands in for a changed text; the API tests change the
 * text itself.
 */

async function clearAcceptance(userId: string, version: number | null = null) {
	await query(
		"update users set acceptable_use_version = $2, acceptable_use_accepted_at = null where id = $1",
		[userId, version],
	);
}

async function currentVersion(): Promise<number> {
	const [row] = await query<{ version: number }>(
		"select coalesce((select acceptable_use_version from settings where id = 1), 1) as version",
	);
	return row?.version ?? 1;
}

test("first sign-in shows the statement, and I accept lands on the workspace", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	await clearAcceptance(student.userId);

	await page.goto("/");
	await expect(page).toHaveURL(/\/acceptable-use$/, { timeout: 15_000 });
	await expect(page.getByRole("heading", { name: "Acceptable use" })).toBeVisible();
	await expect(page.getByTestId("acceptable-use-text")).toContainText("coursework");
	await expect(page).toHaveTitle("Acceptable use, Portikus");

	// The server holds everything else back too.
	const blocked = await page.request.get("/me/settings");
	expect(blocked.status()).toBe(403);
	expect((await blocked.json()).code).toBe("ACCEPTABLE_USE_REQUIRED");

	await page.getByRole("button", { name: "I accept" }).click();
	await expect(page).toHaveURL(new RegExp(`/workspaces/${student.workspaceId}`), {
		timeout: 15_000,
	});
	const [row] = await query<{ acceptable_use_version: number }>(
		"select acceptable_use_version from users where id = $1",
		[student.userId],
	);
	expect(row?.acceptable_use_version).toBe(await currentVersion());
	const audits = await query<{ metadata: { version: number } }>(
		"select metadata from audit_events where action = 'user.acceptable_use_accepted' and target = $1",
		[student.userId],
	);
	expect(audits.map((a) => a.metadata)).toEqual([{ version: await currentVersion() }]);
});

test("an acceptance of an older statement shows it again, from any page", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	await page.goto(`/workspaces/${student.workspaceId}`);
	await expect(page.getByTestId("app-header")).toBeVisible({ timeout: 15_000 });

	// As when an administrator saves a new text: the next request meets the gate.
	await clearAcceptance(student.userId, (await currentVersion()) - 1);
	for (const path of ["/", `/workspaces/${student.workspaceId}`, "/course"]) {
		await page.goto(path);
		await expect(page).toHaveURL(/\/acceptable-use$/, { timeout: 15_000 });
	}
	await expect(page.getByRole("heading", { name: "Acceptable use" })).toBeVisible();
	await page.getByRole("button", { name: "I accept" }).click();
	await expect(page).toHaveURL(new RegExp(`/workspaces/${student.workspaceId}`), {
		timeout: 15_000,
	});
});

test("Sign out signs out", async ({ page, context }) => {
	const student = await createStudent(context);
	await clearAcceptance(student.userId);
	await page.goto("/");
	await expect(page).toHaveURL(/\/acceptable-use$/, { timeout: 15_000 });
	await page.getByRole("button", { name: "Sign out" }).click();
	await expect(page.getByTestId("signin")).toBeVisible({ timeout: 15_000 });
	const me = await page.request.get("/auth/me");
	expect(me.status()).toBe(401);
});

/** A Dex local-password administrator, like the local administrator (SPEC.md section 5.1). */
async function localAdmin(context: BrowserContext): Promise<string> {
	const id = `aup-${crypto.randomUUID()}`;
	const [user] = await query<{ id: string }>(
		`insert into users (oidc_issuer, oidc_subject, email, display_name, role,
		   granted_role, must_change_password)
		 values ($1, $2, $3, 'Local administrator', 'administrator', 'administrator', true)
		 returning id`,
		[MOCK_ISSUER, dexLocalSubject(id), `${id}@example.edu`],
	);
	if (!user) throw new Error("could not create the test user");
	await clearAcceptance(user.id);
	const token = crypto.randomBytes(32).toString("base64url");
	await query(
		`insert into sessions (id, user_id, expires_at)
		 values ($1, $2, now() + interval '1 hour')`,
		[crypto.createHash("sha256").update(token).digest("hex"), user.id],
	);
	await context.addCookies([
		{ name: "portikus_session", value: token, url: WEB_ORIGIN },
	]);
	return user.id;
}

test("a new local administrator changes the password first, then accepts", async ({
	page,
	context,
}) => {
	const userId = await localAdmin(context);
	await page.goto("/acceptable-use");
	await expect(page).toHaveURL(/\/change-password$/, { timeout: 15_000 });

	// change-password.spec.ts drives the real change; here only its result matters.
	await query("update users set must_change_password = false where id = $1", [userId]);
	await page.goto("/admin");
	await expect(page).toHaveURL(/\/acceptable-use$/, { timeout: 15_000 });
	await page.getByRole("button", { name: "I accept" }).click();
	await expect(page).toHaveURL(/\/admin$/, { timeout: 15_000 });
	await expect(page.getByTestId("admin-accounts")).toBeVisible({ timeout: 15_000 });
});
