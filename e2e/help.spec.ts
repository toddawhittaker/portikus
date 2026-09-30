import { type Browser, expect, type Page, test } from "@playwright/test";
import {
	createSignedInUser,
	createStudent,
	loginAs,
	query,
	settledAxe,
	WCAG_TAGS,
	WEB_ORIGIN,
} from "./helpers";

/**
 * The Help page (Epic 25): the account menu opens it in a new tab, each role
 * sees its parts, anchors land on their topic, and it passes axe in both
 * themes (SPEC.md section 25.8). Also the shared chrome P1 changed: the
 * account menu keeps off the window edge, and dialogs follow the density of
 * what opened them.
 */

const PARTS = {
	student: ["Using your workspace"],
	instructor: ["Using your workspace", "For instructors"],
	administrator: ["Using your workspace", "For administrators", "For instructors"],
};

async function partHeadings(page: Page): Promise<string[]> {
	const main = page.getByTestId("page-help");
	await expect(main.getByRole("heading", { level: 1, name: "Help" })).toBeVisible({
		timeout: 15_000,
	});
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

test("Help in the account menu opens the Help page in a new tab", async ({
	page,
	context,
}) => {
	await loginAs(page, "carol");
	await page.goto("/admin");
	await page.getByTestId("me").click();
	const item = page.getByTestId("help-link");
	await expect(item).toHaveAttribute("target", "_blank");
	const [help] = await Promise.all([context.waitForEvent("page"), item.click()]);
	await help.waitForLoadState();
	expect(new URL(help.url()).pathname).toBe("/help");
	await expect(help).toHaveTitle("Help, Portikus");
	expect(await partHeadings(help)).toEqual(PARTS.administrator);
});

test("a student sees only the workspace part", async ({ browser }) => {
	const page = await pageAs(browser, "student");
	await page.goto("/help");
	expect(await partHeadings(page)).toEqual(PARTS.student);
	await expect(page.locator("#admin-users")).toHaveCount(0);
	await page.context().close();
});

test("an instructor sees the workspace and instructor parts", async ({ browser }) => {
	const page = await pageAs(browser, "instructor");
	await page.goto("/help");
	expect(await partHeadings(page)).toEqual(PARTS.instructor);
	await expect(page.locator("#admin-users")).toHaveCount(0);
	await page.context().close();
});

test("an anchor in the address and a contents link both land on their topic", async ({
	page,
}) => {
	await loginAs(page, "carol");
	await page.goto("/help#admin-backups");
	const backups = page.getByRole("heading", { level: 3, name: "Backups and restores" });
	await expect(backups).toBeInViewport({ timeout: 15_000 });
	// Focus lands there too, so Tab and a screen reader start at the topic.
	await expect(backups).toBeFocused();

	const contents = page.getByRole("navigation", { name: "Help contents" });
	await contents.getByRole("link", { name: "The Course page" }).click();
	await expect(page).toHaveURL(/#instructor-course$/);
	await expect(
		page.getByRole("heading", { level: 3, name: "The Course page" }),
	).toBeInViewport();
});

test("a part's anchor focuses the part heading, and a broken anchor still shows the page", async ({
	page,
}) => {
	await loginAs(page, "carol");
	await page.goto("/help#admin");
	await expect(
		page.getByRole("heading", { level: 2, name: "For administrators" }),
	).toBeFocused({ timeout: 15_000 });

	await page.goto("/help#%E0%A4%A");
	expect(await partHeadings(page)).toEqual(PARTS.administrator);
});

test("the account menu keeps 8 px off the window edge (Epic 25 N2)", async ({
	page,
}) => {
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

test("a dialog opened on the compact admin page is compact too (Epic 25 N1)", async ({
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
	test(`the Help page has no automatic accessibility violations (${colorScheme})`, async ({
		page,
	}) => {
		await page.emulateMedia({ colorScheme });
		await loginAs(page, "carol");
		await page.goto("/help");
		expect(await partHeadings(page)).toEqual(PARTS.administrator);
		const results = await (await settledAxe(page)).withTags(WCAG_TAGS).analyze();
		expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
	});
}

/** Settings links here for keys and screen-reader limits (Epic 25 S4). */
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
		"Ctrl+M",
		"Alt+F1",
		"Alt+Shift+Left Arrow, Alt+Shift+Right Arrow",
		"Shift+F10",
		"F8",
	]);
	await expect(topic.locator("dl dd").first()).toHaveText(
		"Leave a terminal. While a terminal has the keyboard, Tab goes to the shell. Each terminal's three-dots menu also has Leave terminal.",
	);
	const contents = page.getByRole("navigation", { name: "Help contents" });
	await expect(contents.getByRole("link")).toHaveText([
		"Using your workspace",
		"Getting started",
		"The workspace layout",
		"Terminals",
		"Files and the editor",
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
		expect(await partHeadings(page)).toEqual(PARTS.student);
		const results = await (await settledAxe(page)).withTags(WCAG_TAGS).analyze();
		expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
		await page.context().close();
	});
}
