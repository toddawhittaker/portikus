/**
 * Linking a course account to an SSO account (docs/EPIC-13-1.md, "The flow"
 * and T3's "What done looks like"). Everything goes through the browser: the
 * mock LMS launch, Settings, the mock OIDC provider and the /link page. Only
 * standard OIDC behaviour of the mock is used (ruling 26).
 */
import { type Browser, expect, type Page, test } from "@playwright/test";
import { apiLoginAs, MOCK_ISSUER, query, WEB_ORIGIN } from "./helpers";
import { launchAs, ltiUsers } from "./lti-helpers";

// Both tests change which account a mock identity resolves to.
test.describe.configure({ mode: "serial" });

async function me(page: Page): Promise<{ id: string; displayName: string }> {
	const response = await page.request.get(`${WEB_ORIGIN}/auth/me`);
	expect(response.status()).toBe(200);
	return (await response.json()) as { id: string; displayName: string };
}

async function openLinkedAccounts(page: Page) {
	await page.getByTestId("me").click();
	await page.getByRole("menuitem", { name: "Settings" }).click();
	const dialog = page.getByTestId("dialog-editor-settings");
	await dialog.getByRole("button", { name: "Profile", exact: true }).click();
	const region = dialog.getByRole("region", { name: "Linked accounts" });
	await expect(region).toBeVisible();
	return region;
}

/** From a fresh course session, start a link and pick `user` on the mock provider. */
async function linkAs(page: Page, user: "bob" | "alice") {
	const region = await openLinkedAccounts(page);
	await region.getByRole("button", { name: "Link to my SSO account" }).click();
	await page.waitForURL(`${MOCK_ISSUER}/authorize**`);
	await page.getByTestId(`mock-user-${user}`).click();
	await page.waitForURL(`${WEB_ORIGIN}/link**`);
}

async function ssoUserId(browser: Browser, user: "bob" | "alice"): Promise<string> {
	const context = await browser.newContext({ baseURL: WEB_ORIGIN });
	try {
		await apiLoginAs(context.request, user);
		const response = await context.request.get("/auth/me");
		return ((await response.json()) as { id: string }).id;
	} finally {
		await context.close();
	}
}

test("a course account links to bob, relaunches into bob, and unlinks", async ({
	browser,
}) => {
	test.setTimeout(120_000);
	const bobId = await ssoUserId(browser, "bob");
	const context = await browser.newContext({ baseURL: WEB_ORIGIN });
	try {
		const page = await context.newPage();
		await launchAs(page, { person: "sam" });
		const [course] = await ltiUsers("sam");
		expect(course).toBeDefined();
		expect((await me(page)).id).toBe(course?.id);
		const oldCookies = await context.cookies();

		await linkAs(page, "bob");
		const accounts = page.getByTestId("link-accounts");
		await expect(accounts).toContainText("Sam Student");
		await expect(accounts).toContainText("Bob Student");
		// Nothing is linked, and nobody is signed in as bob, until confirm.
		expect((await me(page)).id).toBe(course?.id);

		await page.getByRole("button", { name: "Link accounts" }).click();
		await page.waitForURL(`${WEB_ORIGIN}/workspaces/**`, { timeout: 30_000 });
		expect((await me(page)).id).toBe(bobId);
		const [bobWorkspace] = await query<{ id: string }>(
			"select id from workspaces where owner_user_id = $1",
			[bobId],
		);
		expect(page.url()).toContain(`/workspaces/${bobWorkspace?.id}`);

		// The course account's old session is dead.
		const old = await browser.newContext({ baseURL: WEB_ORIGIN });
		await old.addCookies(oldCookies);
		expect((await old.request.get("/auth/me")).status()).toBe(401);
		await old.close();

		// Its workspace is archived, not deleted.
		const courseWorkspaces = await query<{ archived_at: Date | null }>(
			"select archived_at from workspaces where owner_user_id = $1",
			[course?.id],
		);
		for (const row of courseWorkspaces) expect(row.archived_at).not.toBeNull();

		// A relaunch from the course lands in bob's account and workspace.
		await launchAs(page, { person: "sam" });
		expect((await me(page)).id).toBe(bobId);

		// bob sees the link and unlinks it.
		const region = await openLinkedAccounts(page);
		await region.getByRole("button", { name: /^Unlink Sam Student/ }).click();
		await expect(region.getByRole("status")).toContainText("Unlinked.");
		await expect(region).toContainText("No course sign-ins are linked");

		// The next launch signs into the course account again.
		await launchAs(page, { person: "sam" });
		expect((await me(page)).id).toBe(course?.id);
	} finally {
		await context.close();
	}
});

test("a link to an SSO identity with no account is refused", async ({ browser }) => {
	test.setTimeout(120_000);
	// Move alice's row aside so her identity has no account for this test.
	await ssoUserId(browser, "alice");
	const aside = `alice-aside-${Date.now()}`;
	await query(
		"update users set oidc_subject = $1 where oidc_issuer = $2 and oidc_subject = 'alice'",
		[aside, MOCK_ISSUER],
	);
	const context = await browser.newContext({ baseURL: WEB_ORIGIN });
	try {
		const page = await context.newPage();
		await launchAs(page, { person: "sam" });
		const [course] = await ltiUsers("sam");

		await linkAs(page, "alice");
		expect(new URL(page.url()).searchParams.get("error")).toBe("no_account");
		await expect(page.getByRole("alert")).toContainText("never signed in to Portikus");
		// No account was created for alice, and sam is still signed in as the course account.
		const created = await query(
			"select 1 from users where oidc_issuer = $1 and oidc_subject = 'alice'",
			[MOCK_ISSUER],
		);
		expect(created).toHaveLength(0);
		expect((await me(page)).id).toBe(course?.id);
	} finally {
		await context.close();
		// Put alice back unless another spec signed her in meanwhile.
		await query(
			`update users set oidc_subject = 'alice'
			 where oidc_issuer = $1 and oidc_subject = $2
			   and not exists (select 1 from users where oidc_issuer = $1 and oidc_subject = 'alice')`,
			[MOCK_ISSUER, aside],
		);
	}
});
