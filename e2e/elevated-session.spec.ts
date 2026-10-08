import crypto from "node:crypto";
import { expect, test } from "@playwright/test";
import { expectNoViolations, MOCK_ISSUER, query, WEB_ORIGIN } from "./helpers";

/**
 * A role removed in the identity provider takes effect within 12 hours
 * (SPEC.md section 24.13): an administrator session whose role came from
 * the provider ends after 12 hours, and signing in again applies the
 * provider's current groups. The server clock cannot be moved from the
 * browser, so the session is made older in the database instead.
 */

async function seedProviderAdmin(ageMinutes: number): Promise<string> {
	const [user] = await query<{ id: string }>(
		`insert into users (oidc_issuer, oidc_subject, email, display_name, role, provider_role)
		 values ($1, 'rita', 'rita@example.edu', 'Rita Demoted', 'administrator', 'administrator')
		 on conflict (oidc_issuer, oidc_subject) do update
		   set role = 'administrator', provider_role = 'administrator', granted_role = null
		 returning id`,
		[MOCK_ISSUER],
	);
	if (!user) throw new Error("could not create rita");
	const token = crypto.randomBytes(32).toString("base64url");
	await query(
		`insert into sessions (id, user_id, created_at, expires_at, method)
		 values ($1, $2, now() - make_interval(mins => $3), now() + interval '6 hours', 'oidc')`,
		[crypto.createHash("sha256").update(token).digest("hex"), user.id, ageMinutes],
	);
	return token;
}

test.describe.configure({ mode: "serial" });

test("a provider administrator's session at 11 hours 59 minutes still works", async ({
	context,
	page,
}) => {
	const token = await seedProviderAdmin(12 * 60 - 1);
	await context.addCookies([
		{ name: "portikus_session", value: token, url: WEB_ORIGIN },
	]);

	const me = await page.request.get("/auth/me");
	expect(me.status()).toBe(200);
	expect((await me.json()).role).toBe("administrator");
});

test("after 12 hours the provider administrator signs in again and gets the provider's current role", async ({
	context,
	page,
}) => {
	const token = await seedProviderAdmin(12 * 60 + 1);
	await context.addCookies([
		{ name: "portikus_session", value: token, url: WEB_ORIGIN },
	]);

	await page.goto("/admin");
	await expect(page.locator("[data-testid=signin]")).toBeVisible();
	expect((await page.request.get("/auth/me")).status()).toBe(401);

	await page.click("[data-testid=signin]");
	await page.waitForURL(`${MOCK_ISSUER}/authorize**`);
	await page.click("[data-testid=mock-user-rita]");
	await page.waitForURL(`${WEB_ORIGIN}/**`);

	const me = await page.request.get("/auth/me");
	expect(me.status()).toBe(200);
	expect((await me.json()).role).toBe("student");
	expect((await page.request.get("/admin/workspaces")).status()).toBe(403);
});

for (const colorScheme of ["light", "dark"] as const) {
	test(`the session-ended page names the 12-hour limit and passes axe (${colorScheme})`, async ({
		page,
	}) => {
		await page.emulateMedia({ colorScheme });
		await page.goto("/session-ended");
		const ended = page.getByTestId("page-session-ended");
		await expect(ended.getByRole("heading", { level: 1 })).toHaveText(
			"Your session ended",
		);
		// The page is not told why the session ended, so one sentence covers this case for everyone.
		await expect(ended).toContainText(
			"If you are an administrator or instructor through your institution's sign-in, you are also signed out 12 hours after you sign in.",
		);
		await expectNoViolations(page);
	});
}
