/**
 * Linking a course account to an SSO account (docs/EPIC-13-1.md, "The flow"
 * and T3's "What done looks like"). Everything goes through the browser: the
 * mock LMS launch, Settings, the mock OIDC provider and the /link page. Only
 * standard OIDC behaviour of the mock is used (ruling 26).
 *
 * Lin (mock LMS), erin and frank (mock OIDC) exist for this spec alone, so a
 * link never sends another spec's launch into the wrong account.
 */
import { type Browser, expect, type Page, test } from "@playwright/test";
import { apiLoginAs, MOCK_ISSUER, type MockUser, query, WEB_ORIGIN } from "./helpers";
import { launchAs, ltiUsers, type PersonKey } from "./lti-helpers";

const PERSON: PersonKey = "lin";
const TARGET: MockUser = "erin";
const NO_ACCOUNT: MockUser = "frank";

async function me(page: Page): Promise<{ id: string }> {
	const response = await page.request.get(`${WEB_ORIGIN}/auth/me`);
	expect(response.status()).toBe(200);
	return (await response.json()) as { id: string };
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
async function linkAs(page: Page, user: MockUser) {
	const region = await openLinkedAccounts(page);
	await region.getByRole("button", { name: "Link to my SSO account" }).click();
	await page.waitForURL(`${MOCK_ISSUER}/authorize**`);
	await page.getByTestId(`mock-user-${user}`).click();
	await page.waitForURL(`${WEB_ORIGIN}/link**`);
}

/** Sign `user` in once so the account exists; returns its id. */
async function ssoLogin(browser: Browser, user: MockUser): Promise<string> {
	const context = await browser.newContext({ baseURL: WEB_ORIGIN });
	try {
		await apiLoginAs(context.request, user);
		const response = await context.request.get("/auth/me");
		return ((await response.json()) as { id: string }).id;
	} finally {
		await context.close();
	}
}

async function courseUserId(): Promise<string> {
	const [row] = await ltiUsers(PERSON);
	if (!row) throw new Error("Lin has not launched yet");
	return row.id;
}

// Both tests launch Lin; the first links and unlinks her.
test.describe.configure({ mode: "serial" });

test("a course account links to an SSO account, relaunches into it, and unlinks", async ({
	browser,
}) => {
	test.setTimeout(120_000);
	const erinId = await ssoLogin(browser, TARGET);
	const context = await browser.newContext({ baseURL: WEB_ORIGIN });
	try {
		const page = await context.newPage();
		await launchAs(page, { person: PERSON });
		const courseId = await courseUserId();
		expect((await me(page)).id).toBe(courseId);
		const oldCookies = await context.cookies();

		await linkAs(page, TARGET);
		const accounts = page.getByTestId("link-accounts");
		await expect(accounts).toContainText("Lin Linker");
		await expect(accounts).toContainText("Erin Student");
		// Nothing is linked, and nobody is signed in as erin, until confirm.
		expect((await me(page)).id).toBe(courseId);

		await page.getByRole("button", { name: "Link accounts" }).click();
		await page.waitForURL(`${WEB_ORIGIN}/workspaces/**`, { timeout: 30_000 });
		expect((await me(page)).id).toBe(erinId);
		const [erinWorkspace] = await query<{ id: string }>(
			"select id from workspaces where owner_user_id = $1",
			[erinId],
		);
		expect(page.url()).toContain(`/workspaces/${erinWorkspace?.id}`);

		// The course account's old session is dead.
		const old = await browser.newContext({ baseURL: WEB_ORIGIN });
		await old.addCookies(oldCookies);
		expect((await old.request.get("/auth/me")).status()).toBe(401);
		await old.close();

		// Its workspace is archived, not deleted.
		const courseWorkspaces = await query<{ archived_at: Date | null }>(
			"select archived_at from workspaces where owner_user_id = $1",
			[courseId],
		);
		for (const row of courseWorkspaces) expect(row.archived_at).not.toBeNull();

		// A relaunch from the course lands in erin's account.
		await launchAs(page, { person: PERSON });
		expect((await me(page)).id).toBe(erinId);

		// erin sees the link and unlinks it.
		const region = await openLinkedAccounts(page);
		await region.getByRole("button", { name: /^Unlink Lin Linker/ }).click();
		await expect(region.getByRole("status")).toContainText("Unlinked.");
		await expect(region).toContainText("No course sign-ins are linked");

		// The next launch signs into the course account again.
		await launchAs(page, { person: PERSON });
		expect((await me(page)).id).toBe(courseId);
	} finally {
		await context.close();
	}
});

test("a link to an SSO identity with no account is refused", async ({ browser }) => {
	test.setTimeout(120_000);
	const context = await browser.newContext({ baseURL: WEB_ORIGIN });
	try {
		const page = await context.newPage();
		await launchAs(page, { person: PERSON });
		const courseId = await courseUserId();

		await linkAs(page, NO_ACCOUNT);
		expect(new URL(page.url()).searchParams.get("error")).toBe("no_account");
		await expect(page.getByRole("alert")).toContainText("never signed in to Portikus");
		// Link mode created no account, and the course session is untouched.
		const created = await query(
			"select 1 from users where oidc_issuer = $1 and oidc_subject = $2",
			[MOCK_ISSUER, NO_ACCOUNT],
		);
		expect(created).toHaveLength(0);
		expect((await me(page)).id).toBe(courseId);
	} finally {
		await context.close();
	}
});
