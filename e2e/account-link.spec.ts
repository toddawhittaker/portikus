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
import { PEOPLE } from "../packages/mock-lms/src/seed";
import { MOCK_ISSUER, query, WEB_ORIGIN } from "./helpers";
import { LTI_ISSUER, MOCK_LMS_ORIGIN } from "./lti-helpers";

const PERSON = "lin";
const TARGET = "erin";
const NO_ACCOUNT = "frank";

/** lti-helpers' launchAs, for a person its PersonKey type does not list. */
async function launchPerson(page: Page, person: string) {
	await page.goto(`${MOCK_LMS_ORIGIN}/`);
	await page.getByLabel("Person").selectOption(person);
	await page.getByLabel("Course").selectOption("cs101");
	await page.getByRole("button", { name: "Launch Portikus" }).click();
	await page.waitForURL(`${WEB_ORIGIN}/**`, { timeout: 30_000 });
	await expect(page.getByTestId("app-header")).toBeVisible({ timeout: 30_000 });
}

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
async function linkAs(page: Page, user: string) {
	const region = await openLinkedAccounts(page);
	await region.getByRole("button", { name: "Link to my SSO account" }).click();
	await page.waitForURL(`${MOCK_ISSUER}/authorize**`);
	await page.getByTestId(`mock-user-${user}`).click();
	await page.waitForURL(`${WEB_ORIGIN}/link**`);
}

/** helpers' apiLoginAs, for a mock user its MockUser type does not list; returns the account id. */
async function ssoLogin(browser: Browser, user: string): Promise<string> {
	const context = await browser.newContext({ baseURL: WEB_ORIGIN });
	try {
		const authorize = await context.request.get("/auth/login");
		await context.request.get(`${authorize.url()}&user=${user}`);
		const response = await context.request.get("/auth/me");
		return ((await response.json()) as { id: string }).id;
	} finally {
		await context.close();
	}
}

async function courseUserId(): Promise<string> {
	const [row] = await query<{ id: string }>(
		"select id from users where oidc_issuer = $1 and oidc_subject = $2",
		[LTI_ISSUER, PEOPLE.find((p) => p.key === PERSON)?.sub],
	);
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
		await launchPerson(page, PERSON);
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
		await launchPerson(page, PERSON);
		expect((await me(page)).id).toBe(erinId);

		// erin sees the link and unlinks it.
		const region = await openLinkedAccounts(page);
		await region.getByRole("button", { name: /^Unlink Lin Linker/ }).click();
		await expect(region.getByRole("status")).toContainText("Unlinked.");
		await expect(region).toContainText("No course sign-ins are linked");

		// The next launch signs into the course account again.
		await launchPerson(page, PERSON);
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
		await launchPerson(page, PERSON);
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
