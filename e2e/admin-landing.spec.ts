import { type BrowserContext, expect, test } from "@playwright/test";
import { createSignedInUser, query, WEB_ORIGIN } from "./helpers";

/**
 * Administrators land on the administration page and get a workspace only
 * when they open one (SPEC.md §6.1, issue #534). These use a fresh
 * administrator with a database session: carol may already have a workspace
 * from another spec, and every browser sign-in counts against the sign-in
 * rate limit. The real sign-in by carol and alice is in admin.spec.ts.
 */

/** A new administrator with a session and no workspace. */
async function createAdmin(context: BrowserContext): Promise<string> {
	return (await createSignedInUser(context, "administrator")).userId;
}

async function workspacesOf(userId: string): Promise<string[]> {
	const rows = await query<{ id: string }>(
		"select id from workspaces where owner_user_id = $1",
		[userId],
	);
	return rows.map((row) => row.id);
}

test("the front page makes no workspace for an administrator", async ({
	page,
	context,
}) => {
	const adminId = await createAdmin(context);

	await page.goto("/");
	await expect(page).toHaveURL(`${WEB_ORIGIN}/admin`, { timeout: 15_000 });
	await expect(page.getByTestId("page-admin")).toBeVisible();
	// The mark goes to "/" off a workspace; that must not make one either.
	// Wait for the real trip through "/" and back, or this checks nothing.
	const throughFront = page.waitForURL(`${WEB_ORIGIN}/`);
	await page
		.getByRole("link", { name: /Portikus/ })
		.first()
		.click();
	await throughFront;
	await page.waitForURL(`${WEB_ORIGIN}/admin`);
	await expect(page.getByTestId("page-admin")).toBeVisible();

	expect(await workspacesOf(adminId)).toEqual([]);
});

test("Open my workspace makes the workspace and opens it in this tab", async ({
	page,
	context,
}) => {
	const adminId = await createAdmin(context);
	await page.goto("/admin");

	await page.getByTestId("open-my-workspace").click();

	await expect(page).toHaveURL(/\/workspaces\/[0-9a-f-]{36}$/, { timeout: 15_000 });
	const ids = await workspacesOf(adminId);
	expect(ids).toHaveLength(1);
	expect(page.url()).toBe(`${WEB_ORIGIN}/workspaces/${ids[0]}`);

	// Administration is still in the workspace's account menu.
	await page.getByTestId("me").click({ timeout: 15_000 });
	await expect(page.getByTestId("admin-link")).toHaveAttribute("href", "/admin");

	// A second open reuses the same workspace.
	await page.goto("/admin");
	await page.getByTestId("open-my-workspace").click();
	await expect(page).toHaveURL(`${WEB_ORIGIN}/workspaces/${ids[0]}`, {
		timeout: 15_000,
	});
	expect(await workspacesOf(adminId)).toEqual(ids);
});
