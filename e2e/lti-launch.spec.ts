/**
 * A student opens Portikus from a course (docs/archive/epics/EPIC-13.md rulings 3, 18
 * and 20; SPEC.md section 5 and Epic 8).
 */
import { expect, test } from "@playwright/test";
import { query, WEB_ORIGIN } from "./helpers";
import { launchAs, ltiUsers, signedIn, startLaunch } from "./lti-helpers";

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

for (const [person, username, label] of [
	["sam", "sam.student", "sam-student"],
	["lee", "lee", "lee"],
	["ivy", null, "ivy"],
] as const) {
	test(`an LTI user's workspace is named after their LMS username, else their email (${person})`, async ({
		page,
	}) => {
		// Sam's username comes as the custom claim, Lee's as preferred_username (issue #549);
		// Ivy has none, so her email's local part names it (issue #558).
		await launchAs(page, { person });
		await expect(page.getByTestId("workspace-state")).toBeVisible({ timeout: 15_000 });
		const [user] = await ltiUsers(person);
		const [row] = await query<{ preferred_username: string | null }>(
			"select preferred_username from users where id = $1",
			[user?.id],
		);
		expect(row?.preferred_username ?? null).toBe(username);
		await expect
			.poll(async () => {
				const rows = await query<{ label: string }>(
					"select label from workspaces where owner_user_id = $1",
					[user?.id],
				);
				return rows[0]?.label ?? null;
			})
			.toBe(label);
	});
}

test("two LTI links opened at once both sign in, whichever launch lands first", async ({
	page,
	context,
}) => {
	// Hold each launch post back so both logins finish before either launch.
	const held: string[] = [];
	await context.route(`${WEB_ORIGIN}/lti/launch`, async (route) => {
		held.push(route.request().postData() ?? "");
		await route.abort();
	});
	const second = await context.newPage();
	for (const tab of [page, second]) {
		await startLaunch(tab, { person: "sam" });
		await expect.poll(() => held.length).toBe(tab === page ? 1 : 2);
	}
	await context.unroute(`${WEB_ORIGIN}/lti/launch`);

	// Each login set its own state cookie.
	// Unfiltered: a URL filter hides Secure cookies on plain-http 127.0.0.1.
	const states = (await context.cookies()).filter((c) =>
		c.name.startsWith("__Host-portikus_lti_state_"),
	);
	expect(states).toHaveLength(2);

	// Now post them in reverse order, each as the platform's form would.
	for (const body of [...held].reverse()) {
		const fields = new URLSearchParams(body);
		const inputs = [...fields]
			.map(([name, value]) => `<input type="hidden" name="${name}" value="${value}">`)
			.join("");
		await page.setContent(
			`<form method="post" action="${WEB_ORIGIN}/lti/launch">${inputs}<button type="submit">Post</button></form>`,
		);
		const launched = page.waitForResponse(
			(r) => r.url() === `${WEB_ORIGIN}/lti/launch` && r.request().method() === "POST",
		);
		await page.getByRole("button", { name: "Post" }).click();
		expect((await launched).status()).toBe(303);
		await expect(page.getByTestId("app-header")).toBeVisible({ timeout: 30_000 });
		expect(await signedIn(page)).toBe(true);
	}
	await second.close();
});
