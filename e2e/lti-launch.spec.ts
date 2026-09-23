/**
 * A student opens Portikus from a course (docs/EPIC-13.md rulings 3, 12, 18
 * and 20; SPEC.md section 5).
 */
import { expect, test } from "@playwright/test";
import { query, WEB_ORIGIN } from "./helpers";
import { launchAs, ltiUsers, signedIn } from "./lti-helpers";

test("a student launch lands in the student's own workspace, signed in", async ({
	page,
}) => {
	await launchAs(page, { person: "sam" });

	expect(new URL(page.url()).origin).toBe(WEB_ORIGIN);
	await expect(page.getByTestId("workspace-state")).toBeVisible({ timeout: 15_000 });
	const me = await page.request.get("/auth/me");
	expect(me.status()).toBe(200);
	const body = (await me.json()) as { displayName: string; role: string };
	expect(body.displayName).toBe("Sam Student");
	expect(body.role).toBe("student");

	// A student has no Course page and no administration link.
	await expect(page.getByRole("link", { name: "Course" })).toHaveCount(0);
	await page.getByTestId("me").click();
	await expect(page.getByTestId("admin-link")).toHaveCount(0);
});

test("a second launch finds the same account instead of making another", async ({
	browser,
}) => {
	const first = await browser.newContext({ baseURL: WEB_ORIGIN });
	const second = await browser.newContext({ baseURL: WEB_ORIGIN });
	try {
		const firstPage = await first.newPage();
		await launchAs(firstPage, { person: "lee" });
		const secondPage = await second.newPage();
		await launchAs(secondPage, { person: "lee" });

		const rows = await ltiUsers("lee");
		expect(rows).toHaveLength(1);
		// Not linked by email to any other account (ruling 3).
		const byEmail = await query("select id from users where email = $1", [
			"lee@mock-lms.test",
		]);
		expect(byEmail).toHaveLength(1);

		// Both sessions belong to that one user.
		const sessions = await query<{ user_id: string }>(
			"select distinct user_id from sessions where user_id = $1",
			[rows[0]?.id],
		);
		expect(sessions).toHaveLength(1);
		expect(await signedIn(firstPage)).toBe(true);
		expect(await signedIn(secondPage)).toBe(true);
	} finally {
		await first.close();
		await second.close();
	}
});

test("an LTI user is stored under the lti: issuer with no username", async ({
	page,
}) => {
	await launchAs(page, { person: "sam" });
	const [row] = await query<{ preferred_username: string | null }>(
		"select preferred_username from users where oidc_issuer like 'lti:%' and email = $1",
		["sam@mock-lms.test"],
	);
	expect(row?.preferred_username ?? null).toBeNull();
});
