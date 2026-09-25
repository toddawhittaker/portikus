/**
 * Linking a course account to an SSO account (docs/archive/epics/EPIC-13-1.md, "The flow"
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

/**
 * From a fresh course session, start a link, which opens the SSO sign-in in
 * a new tab, and pick `user` there. Returns that tab, now on /link.
 */
async function linkAs(page: Page, user: MockUser): Promise<Page> {
	const region = await openLinkedAccounts(page);
	const [tab] = await Promise.all([
		page.context().waitForEvent("page"),
		region.getByRole("button", { name: "Link to my SSO account" }).click(),
	]);
	await expect(region.getByRole("status")).toHaveText(
		"Finish signing in in the new tab.",
	);
	await tab.waitForURL(`${MOCK_ISSUER}/authorize**`);
	await tab.getByTestId(`mock-user-${user}`).click();
	await tab.waitForURL(`${WEB_ORIGIN}/link**`);
	return tab;
}

/** Confirm in the link tab; the original tab reloads into the SSO account. */
async function confirmLink(page: Page, tab: Page) {
	// The original tab is already on a workspace, so wait for its reload, not a URL.
	await Promise.all([
		page.waitForEvent("load", { timeout: 30_000 }),
		tab.getByRole("button", { name: "Link accounts" }).click(),
	]);
	await page.waitForURL(`${WEB_ORIGIN}/workspaces/**`, { timeout: 30_000 });
	await expect(page.getByTestId("dialog-editor-settings")).toBeHidden();
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

// Every test launches Lin; the first two link and unlink her.
test.describe.configure({ mode: "serial" });

// A failed or retried run must not leave Lin linked or her workspace archived.
test.beforeEach(async () => {
	for (const row of await ltiUsers(PERSON)) {
		await query("delete from account_links where course_user_id = $1", [row.id]);
		await query("update workspaces set archived_at = null where owner_user_id = $1", [
			row.id,
		]);
	}
});

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

		const tab = await linkAs(page, TARGET);
		const accounts = tab.getByTestId("link-accounts");
		await expect(accounts).toContainText("Lin Linker");
		await expect(accounts).toContainText("Erin Student");
		// Nothing is linked, and nobody is signed in as erin, until confirm.
		expect((await me(page)).id).toBe(courseId);

		await confirmLink(page, tab);
		// The link tab closes itself; it was opened by script, so the browser allows it.
		await expect.poll(() => tab.isClosed()).toBe(true);
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
		expect(courseWorkspaces).toHaveLength(1);
		for (const row of courseWorkspaces) expect(row.archived_at).not.toBeNull();

		// A relaunch from the course lands in erin's account.
		await launchAs(page, { person: PERSON });
		expect((await me(page)).id).toBe(erinId);

		// erin, signed in with SSO, sees the link and unlinks it. Unlinking from
		// the relaunched session itself ends that session (review S2), which the
		// API tests cover.
		await apiLoginAs(context.request, TARGET);
		await page.goto("/");
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

test("a launch into a linked account can unlink it from the course side", async ({
	browser,
}) => {
	test.setTimeout(120_000);
	const erinId = await ssoLogin(browser, TARGET);
	const context = await browser.newContext({ baseURL: WEB_ORIGIN });
	try {
		const page = await context.newPage();
		await launchAs(page, { person: PERSON });
		const courseId = await courseUserId();
		await confirmLink(page, await linkAs(page, TARGET));

		await launchAs(page, { person: PERSON });
		expect((await me(page)).id).toBe(erinId);
		const notice = page.getByRole("region", { name: "Course sign-in" });
		await expect(notice).toContainText(/Opened from .+ as Erin Student\. Not you\?/);
		// The status region outside the notice, mounted before the text, announces it.
		await expect(page.getByTestId("launch-notice-status")).toHaveText(
			/^Opened from .+ as Erin Student\. Not you\?$/,
		);

		await notice.getByRole("button", { name: "Unlink this course sign-in" }).click();
		await page
			.getByTestId("launch-unlink-confirm")
			.getByTestId("dialog-confirm")
			.click();
		const unlinked = page.getByTestId("page-unlinked");
		await expect(unlinked).toContainText(
			"Open Portikus again from your course to continue with your course account.",
		);
		await expect(unlinked.getByRole("link")).toHaveCount(0);
		expect((await page.request.get("/auth/me")).status()).toBe(401);

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

		const tab = await linkAs(page, NO_ACCOUNT);
		expect(new URL(tab.url()).searchParams.get("error")).toBe("no_account");
		await expect(tab.getByRole("alert")).toContainText("never signed in to Portikus");
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
