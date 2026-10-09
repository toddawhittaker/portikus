import { type Browser, expect, type Page, test } from "@playwright/test";
import {
	createSignedInUser,
	createStudent,
	expectNoViolations,
	loginAs,
	query,
	settledAxe,
	WCAG_TAGS,
	WEB_ORIGIN,
	workspacePath,
} from "./helpers";

/**
 * The two help pages (SPEC.md section 8.6): "Using your workspace" at /help,
 * with the instructor part for anyone who teaches and every administrator,
 * and "For administrators" at /admin/help inside the admin page. The account
 * menu's Help opens the one that fits where you are, in a new tab; anchors
 * land on their topic; both pages pass axe in both themes (SPEC.md section
 * 25.8). Also the shared chrome: the account menu keeps off the window edge,
 * and dialogs follow the density of what opened them.
 */

const WORKSPACE_PARTS = {
	student: ["Your workspace"],
	instructor: ["Your workspace", "For instructors"],
	administrator: ["Your workspace", "For instructors"],
};

async function partHeadings(page: Page): Promise<string[]> {
	const main = page.getByTestId("page-help");
	await expect(
		main.getByRole("heading", { level: 1, name: "Using your workspace" }),
	).toBeVisible({ timeout: 15_000 });
	return main.getByRole("heading", { level: 2 }).allTextContents();
}

async function adminHelpHeadings(page: Page): Promise<string[]> {
	const main = page.getByTestId("page-admin");
	await expect(
		main.getByRole("heading", { level: 1, name: "For administrators" }),
	).toBeVisible({ timeout: 15_000 });
	return main.getByRole("heading", { level: 2 }).allTextContents();
}

/** A fresh signed-in page for one role, in its own browser context. */
async function pageAs(browser: Browser, role: "student" | "instructor"): Promise<Page> {
	const context = await browser.newContext({ baseURL: WEB_ORIGIN });
	const { userId } = await createSignedInUser(context, "student");
	if (role === "instructor") {
		await query("update users set role = 'instructor' where id = $1", [userId]);
	}
	return context.newPage();
}

test("Help from an admin tab opens the administrator help, with the tabs still there", async ({
	page,
	context,
}) => {
	await loginAs(page, "carol");
	await page.goto("/admin/health");
	await page.getByTestId("me").click();
	const item = page.getByTestId("help-link");
	await expect(item).toHaveAttribute("target", "_blank");
	await expect(item).toHaveAttribute("href", "/admin/help");
	const [help] = await Promise.all([context.waitForEvent("page"), item.click()]);
	await help.waitForLoadState();
	expect(new URL(help.url()).pathname).toBe("/admin/help");
	expect(await adminHelpHeadings(help)).toEqual(["Running the site"]);
	await expect(help).toHaveTitle("For administrators, Administration, Portikus");
	const tabs = help.getByRole("navigation", { name: "Administration" });
	await expect(tabs.getByRole("link", { name: "Users" })).toBeVisible();
	await expect(help.locator("#student-keyboard")).toHaveCount(0);

	// Each help page links across to the other.
	await help.getByRole("link", { name: "Using your workspace" }).click();
	await expect(help).toHaveURL(/\/help$/);
	expect(await partHeadings(help)).toEqual(WORKSPACE_PARTS.administrator);
	await help.getByRole("link", { name: "For administrators" }).click();
	await expect(help).toHaveURL(/\/admin\/help$/);
	expect(await adminHelpHeadings(help)).toEqual(["Running the site"]);
});

test("Help from a workspace opens the workspace help", async ({ browser }) => {
	const context = await browser.newContext({ baseURL: WEB_ORIGIN });
	const student = await createStudent(context);
	const page = await context.newPage();
	await page.goto(workspacePath(student.workspaceId));
	await page.getByTestId("me").click();
	const item = page.getByTestId("help-link");
	await expect(item).toHaveAttribute("href", "/help");
	const [help] = await Promise.all([context.waitForEvent("page"), item.click()]);
	await help.waitForLoadState();
	expect(new URL(help.url()).pathname).toBe("/help");
	await expect(help).toHaveTitle("Using your workspace, Help, Portikus");
	expect(await partHeadings(help)).toEqual(WORKSPACE_PARTS.student);
	await context.close();
});

test("a student sees only the workspace part and cannot open the administrator help", async ({
	browser,
}) => {
	const page = await pageAs(browser, "student");
	await page.goto("/help");
	expect(await partHeadings(page)).toEqual(WORKSPACE_PARTS.student);
	await expect(page.locator("#admin-users")).toHaveCount(0);
	await expect(page.getByRole("link", { name: "For administrators" })).toHaveCount(0);

	await page.goto("/admin/help#admin-users");
	await expect(page).toHaveURL(/\/not-authorized$/, { timeout: 15_000 });
	await expect(page.locator("#admin-users")).toHaveCount(0);
	await page.context().close();
});

test("an instructor sees the workspace and instructor parts, and no administrator help", async ({
	browser,
}) => {
	const page = await pageAs(browser, "instructor");
	await page.goto("/help");
	expect(await partHeadings(page)).toEqual(WORKSPACE_PARTS.instructor);
	await expect(page.locator("#admin-users")).toHaveCount(0);

	await page.goto("/admin/help");
	await expect(page).toHaveURL(/\/not-authorized$/, { timeout: 15_000 });
	await page.context().close();
});

test("an admin anchor and a contents link both land on their topic", async ({
	page,
}) => {
	await loginAs(page, "carol");
	await page.goto("/admin/help#admin-backups");
	const backups = page.getByRole("heading", { level: 3, name: "Backups and restores" });
	await expect(backups).toBeInViewport({ timeout: 15_000 });
	// Focus lands there too, so Tab and a screen reader start at the topic.
	await expect(backups).toBeFocused();

	const contents = page.getByRole("navigation", { name: "Help contents" });
	await contents.getByRole("link", { name: "Site settings" }).click();
	await expect(page).toHaveURL(/#admin-settings$/);
	await expect(
		page.getByRole("heading", { level: 3, name: "Site settings" }),
	).toBeInViewport();
});

test("an admin tab's More in Help lands on its topic in the administrator help", async ({
	page,
	context,
}) => {
	await loginAs(page, "carol");
	await page.goto("/admin/health");
	const more = page.getByRole("link", { name: /More in Help/ });
	await expect(more).toHaveAttribute("href", "/admin/help#admin-health");
	const [help] = await Promise.all([context.waitForEvent("page"), more.click()]);
	await expect(help.getByRole("heading", { level: 3, name: "Health" })).toBeFocused({
		timeout: 15_000,
	});
});

test("the Users tab's More in Help reaches the topic on inviting people and the CSV import", async ({
	page,
	context,
}) => {
	await loginAs(page, "carol");
	await page.goto("/admin");
	const more = page.getByRole("link", { name: /More in Help/ });
	await expect(more).toHaveAttribute("href", "/admin/help#admin-users");
	const [help] = await Promise.all([context.waitForEvent("page"), more.click()]);
	await expect(
		help.getByRole("heading", { level: 3, name: "Find a person and their workspace" }),
	).toBeFocused({ timeout: 15_000 });

	// The invitations topic follows straight after, and the contents name it.
	const contents = help.getByRole("navigation", { name: "Help contents" });
	await contents.getByRole("link", { name: "Inviting people" }).click();
	await expect(help).toHaveURL(/#admin-invitations$/);
	const topic = help.locator("section:has(> h3#admin-invitations)");
	await expect(topic).toBeInViewport();
	await expect(
		help.getByRole("heading", { level: 3, name: "Inviting people" }),
	).toBeFocused();
	await expect(topic).toContainText("Invite…");
	await expect(topic).toContainText("user principal name");
	await expect(topic).toContainText("Import from CSV…");
	await expect(topic).toContainText("Download passwords");
});

for (const colorScheme of ["light", "dark"] as const) {
	test(`the administrator help with the invitations topic passes axe (${colorScheme})`, async ({
		page,
	}) => {
		await page.emulateMedia({ colorScheme });
		await loginAs(page, "carol");
		await page.goto("/admin/help#admin-invitations");
		await expect(
			page.getByRole("heading", { level: 3, name: "Inviting people" }),
		).toBeFocused({ timeout: 15_000 });
		await expectNoViolations(page);
	});
}

test("the Course page's anchor lands on its topic in the workspace help", async ({
	browser,
}) => {
	const page = await pageAs(browser, "instructor");
	await page.goto("/help#instructor-course");
	const course = page.getByRole("heading", { level: 3, name: "The Course page" });
	await expect(course).toBeInViewport({ timeout: 15_000 });
	await expect(course).toBeFocused();
	await page.context().close();
});

test("a part's anchor focuses the part heading, and a broken anchor still shows the page", async ({
	page,
}) => {
	await loginAs(page, "carol");
	await page.goto("/admin/help#admin");
	await expect(
		page.getByRole("heading", { level: 2, name: "Running the site" }),
	).toBeFocused({ timeout: 15_000 });

	await page.goto("/help#%E0%A4%A");
	expect(await partHeadings(page)).toEqual(WORKSPACE_PARTS.administrator);
});

test("the account menu keeps 8 px off the window edge", async ({ page }) => {
	await loginAs(page, "carol");
	await page.goto("/admin");
	await page.getByTestId("me").click();
	const menu = page.getByRole("menu");
	await expect(menu).toBeVisible();
	const box = await menu.boundingBox();
	const width = page.viewportSize()?.width ?? 0;
	expect(box).not.toBeNull();
	expect(width - ((box?.x ?? 0) + (box?.width ?? 0))).toBeGreaterThanOrEqual(8);
});

test("a dialog opened on the compact admin page is compact too", async ({
	page,
	browser,
}) => {
	const other = await browser.newContext();
	const student = await createStudent(other);
	await other.close();
	const name = `Density ${student.userId.slice(0, 8)}`;
	await query("update users set display_name = $2 where id = $1", [
		student.userId,
		name,
	]);

	await loginAs(page, "carol");
	await page.goto("/admin");
	await page.getByTestId("admin-filter-text").fill(name);
	await page.getByRole("button", { name: `Show details for ${name}` }).click();
	await page.getByRole("button", { name: /^Edit quotas/ }).click();
	const dialog = page.getByRole("dialog");
	await expect(dialog).toHaveAttribute("data-density", "compact");
	await dialog.getByRole("button", { name: "Cancel" }).click();
	await expect(dialog).toBeHidden();
});

for (const colorScheme of ["light", "dark"] as const) {
	test(`both help pages have no automatic accessibility violations (${colorScheme})`, async ({
		page,
	}) => {
		await page.emulateMedia({ colorScheme });
		await loginAs(page, "carol");
		await page.goto("/help");
		expect(await partHeadings(page)).toEqual(WORKSPACE_PARTS.administrator);
		const workspace = await (await settledAxe(page)).withTags(WCAG_TAGS).analyze();
		expect(workspace.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);

		await page.goto("/admin/help");
		expect(await adminHelpHeadings(page)).toEqual(["Running the site"]);
		const admin = await (await settledAxe(page)).withTags(WCAG_TAGS).analyze();
		expect(admin.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
	});
}

/** Settings links here for keys and screen-reader limits. */
test("a student lands on the keyboard topic from its anchor", async ({ browser }) => {
	const page = await pageAs(browser, "student");
	await page.goto("/help#student-keyboard");
	const heading = page.getByRole("heading", {
		level: 3,
		name: "Keyboard and screen readers",
	});
	await expect(heading).toBeInViewport({ timeout: 15_000 });
	const topic = page.locator("section", { has: heading });
	await expect(topic.locator("dl dt")).toHaveText([
		"Alt+Shift+Q",
		"Alt+Shift+M",
		"Ctrl+M",
		"Alt+Shift+Left Arrow, Alt+Shift+Right Arrow",
		"Shift+F10",
		"F8",
	]);
	await expect(topic.locator("dl dd").first()).toHaveText(
		"Leave a terminal. While a terminal has the keyboard, Tab goes to the shell. Each terminal's three-dots menu also has Leave terminal.",
	);
	// The click ways to move a tab are written down beside the keys.
	await expect(topic.locator("dl dd").nth(3)).toContainText(
		"A tab's menu also has Move left and Move right.",
	);
	await expect(topic.locator("dl dd").nth(4)).toContainText(
		"Open the menu of the focused tab",
	);
	const contents = page.getByRole("navigation", { name: "Help contents" });
	await expect(contents.getByRole("link")).toHaveText([
		"Your workspace",
		"Getting started",
		"The workspace layout",
		"Keep your workspace running while you are away",
		"Terminals",
		"Voice input in a terminal",
		"Files and the editor",
		"Recovery points",
		"Previews",
		"Container images with GitHub Actions",
		"Checks",
		"Settings",
		"Keyboard and screen readers",
		"When something goes wrong",
	]);
	await page.context().close();
});

for (const colorScheme of ["light", "dark"] as const) {
	test(`a student's Help page passes axe at the narrowest window (${colorScheme})`, async ({
		browser,
	}) => {
		const page = await pageAs(browser, "student");
		// The product's narrowest window (.pk-root min-width).
		await page.setViewportSize({ width: 1024, height: 800 });
		await page.emulateMedia({ colorScheme });
		await page.goto("/help");
		expect(await partHeadings(page)).toEqual(WORKSPACE_PARTS.student);
		const results = await (await settledAxe(page)).withTags(WCAG_TAGS).analyze();
		expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
		await page.context().close();
	});
}
