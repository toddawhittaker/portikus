import * as crypto from "node:crypto";
import { type Browser, expect, type Page, test } from "@playwright/test";
import { createStudent, openAdmin, query } from "./helpers";

/**
 * The Users page's ways to add people and its inspector (SPEC.md sections
 * 5.1 and 20.1), driven by keyboard as well as pointer (section 25.8).
 */
test.use({ viewport: { width: 1440, height: 900 } });

test.describe("the More menu beside Add user", () => {
	test("sits beside Add user, opens on a click, and holds Invite and Import", async ({
		page,
	}) => {
		await openAdmin(page);
		const add = page.getByRole("button", { name: "Add user…" });
		const more = page.getByRole("button", { name: "More", exact: true });
		await expect(add).toBeVisible();
		await expect(more).toHaveAttribute("aria-haspopup", "menu");
		await expect(more).toHaveAttribute("aria-expanded", "false");

		// Beside means on the same line, More after Add user.
		const addBox = await add.boundingBox();
		const moreBox = await more.boundingBox();
		if (!addBox || !moreBox) throw new Error("a button has no box");
		expect(moreBox.x).toBeGreaterThan(addBox.x);
		expect(
			Math.abs(moreBox.y + moreBox.height / 2 - (addBox.y + addBox.height / 2)),
		).toBeLessThan(4);

		await more.click();
		const menu = page.getByRole("menu", { name: "More", exact: true });
		await expect(menu).toBeVisible();
		// The open menu hides the page behind it from the accessibility tree, so find More by its id.
		await expect(page.getByTestId("users-add-more")).toHaveAttribute(
			"aria-expanded",
			"true",
		);
		await expect(menu.getByRole("menuitem")).toHaveText([
			"Invite…",
			"Import from CSV…",
		]);

		await menu.getByRole("menuitem", { name: "Invite…" }).click();
		const invite = page.getByRole("dialog", { name: "Invite someone" });
		await expect(invite).toBeVisible();
		await expect(menu).toBeHidden();
		await page.keyboard.press("Escape");
		await expect(invite).toBeHidden();

		await more.click();
		await page.getByRole("menuitem", { name: "Import from CSV…" }).click();
		await expect(page.getByRole("dialog", { name: "Import from CSV" })).toBeVisible();
	});

	test("is reachable and usable from the keyboard alone", async ({ page }) => {
		await openAdmin(page);
		const add = page.getByRole("button", { name: "Add user…" });
		const more = page.getByRole("button", { name: "More", exact: true });

		// Tab moves from Add user straight to More.
		await add.focus();
		await page.keyboard.press("Tab");
		await expect(more).toBeFocused();

		// Enter opens the menu on its first item; Escape closes it back to More.
		await page.keyboard.press("Enter");
		const menu = page.getByRole("menu", { name: "More", exact: true });
		await expect(menu).toBeVisible();
		await expect(menu.getByRole("menuitem", { name: "Invite…" })).toBeFocused();
		await page.keyboard.press("Escape");
		await expect(menu).toBeHidden();
		await expect(more).toBeFocused();

		// Arrow keys move between the items, and Enter opens the chosen dialog.
		await page.keyboard.press("ArrowDown");
		await expect(menu).toBeVisible();
		await page.keyboard.press("ArrowDown");
		await expect(
			menu.getByRole("menuitem", { name: "Import from CSV…" }),
		).toBeFocused();
		await page.keyboard.press("Enter");
		const importing = page.getByRole("dialog", { name: "Import from CSV" });
		await expect(importing).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(importing).toBeHidden();

		await more.focus();
		await page.keyboard.press("Enter");
		await expect(menu.getByRole("menuitem", { name: "Invite…" })).toBeFocused();
		await page.keyboard.press("Enter");
		await expect(page.getByRole("dialog", { name: "Invite someone" })).toBeVisible();
	});
});

/** A student renamed with a tag, so the Users filter finds only this test's people. */
async function namedStudent(browser: Browser, name: string) {
	const context = await browser.newContext();
	const student = await createStudent(context);
	await context.close();
	await query("update users set display_name = $2 where id = $1", [
		student.userId,
		name,
	]);
	const [row] = await query<{ email: string }>(
		"select email from users where id = $1",
		[student.userId],
	);
	if (!row) throw new Error("the student has no row");
	return { ...student, name, email: row.email };
}

/** The inspector's three panels, by the section each one leads with. */
function sections(page: Page, name: string) {
	const panel = page.getByRole("region", { name });
	return {
		panel,
		tabs: panel.getByRole("tablist", { name: "Workspace details" }),
		resources: panel.getByRole("region", { name: "Resources" }),
		processes: panel.getByRole("region", { name: "Processes" }),
		ports: panel.getByRole("region", { name: "Ports and connections" }),
		audit: panel.getByRole("region", { name: "Recent audit events" }),
		account: panel.getByRole("region", { name: "Account", exact: true }),
	};
}

test.describe("the inspector's tabs", () => {
	test("Overview, Activity and Account are tabs, each showing its own part for the chosen row", async ({
		page,
		browser,
	}) => {
		const tag = `Inspector ${crypto.randomUUID().slice(0, 8)}`;
		const ada = await namedStudent(browser, `${tag} Ada`);
		const ben = await namedStudent(browser, `${tag} Ben`);
		await openAdmin(page);
		await page.getByTestId("admin-filter-text").fill(tag);
		await page.getByRole("button", { name: `Show details for ${ada.name}` }).click();

		const a = sections(page, ada.name);
		await expect(a.tabs.getByRole("tab")).toHaveText([
			"Overview",
			"Activity",
			"Account",
		]);
		const overview = a.tabs.getByRole("tab", { name: "Overview" });
		const activity = a.tabs.getByRole("tab", { name: "Activity" });
		const account = a.tabs.getByRole("tab", { name: "Account" });

		// A row opens on Overview: resources, not the other tabs' sections.
		await expect(overview).toHaveAttribute("aria-selected", "true");
		await expect(a.resources).toBeVisible({ timeout: 15_000 });
		await expect(a.processes).toBeHidden();
		await expect(a.account).toBeHidden();
		await expect(a.panel.getByRole("tabpanel")).toHaveCount(1);

		await activity.click();
		await expect(activity).toHaveAttribute("aria-selected", "true");
		await expect(overview).toHaveAttribute("aria-selected", "false");
		await expect(a.processes).toBeVisible();
		await expect(a.ports).toBeVisible();
		await expect(a.audit).toBeVisible();
		await expect(a.resources).toBeHidden();
		await expect(a.account).toBeHidden();

		await account.click();
		await expect(account).toHaveAttribute("aria-selected", "true");
		await expect(a.account).toBeVisible();
		await expect(a.account.getByTestId("detail-email")).toHaveText(ada.email);
		await expect(a.processes).toBeHidden();
		await expect(a.resources).toBeHidden();
		// The visible panel is the one the selected tab controls.
		const shown = a.panel.getByRole("tabpanel");
		await expect(shown).toHaveCount(1);
		await expect(shown).toHaveAttribute(
			"id",
			(await account.getAttribute("aria-controls")) ?? "",
		);

		// Another row shows its own account, never the last row's, and starts on Overview again.
		await page.getByRole("button", { name: `Show details for ${ben.name}` }).click();
		const b = sections(page, ben.name);
		await expect(b.tabs.getByRole("tab", { name: "Overview" })).toHaveAttribute(
			"aria-selected",
			"true",
		);
		await expect(b.resources).toBeVisible({ timeout: 15_000 });
		await b.tabs.getByRole("tab", { name: "Account" }).click();
		await expect(b.account.getByTestId("detail-email")).toHaveText(ben.email);
		await expect(b.panel.getByText(ada.email)).toHaveCount(0);
	});

	test("arrow keys move between the tabs, wrapping at the ends, and Tab leaves for the panel", async ({
		page,
		browser,
	}) => {
		const student = await namedStudent(
			browser,
			`Arrows ${crypto.randomUUID().slice(0, 8)} Student`,
		);
		await openAdmin(page);
		await page.getByTestId("admin-filter-text").fill(student.name);
		await page
			.getByRole("button", { name: `Show details for ${student.name}` })
			.click();
		const s = sections(page, student.name);
		await expect(s.resources).toBeVisible({ timeout: 15_000 });
		const tab = (name: string) => s.tabs.getByRole("tab", { name });

		await tab("Overview").focus();
		await page.keyboard.press("ArrowRight");
		await expect(tab("Activity")).toBeFocused();
		await expect(tab("Activity")).toHaveAttribute("aria-selected", "true");
		await expect(s.processes).toBeVisible();

		await page.keyboard.press("ArrowRight");
		await expect(tab("Account")).toBeFocused();
		await expect(s.account).toBeVisible();

		await page.keyboard.press("ArrowRight");
		await expect(tab("Overview")).toBeFocused();
		await expect(s.resources).toBeVisible();

		await page.keyboard.press("ArrowLeft");
		await expect(tab("Account")).toBeFocused();
		await page.keyboard.press("Home");
		await expect(tab("Overview")).toBeFocused();
		await page.keyboard.press("End");
		await expect(tab("Account")).toBeFocused();
		await expect(tab("Account")).toHaveAttribute("aria-selected", "true");

		// One tab stop for the whole list: Tab goes on into the panel, not to the next tab.
		await expect(tab("Overview")).toHaveAttribute("tabindex", "-1");
		await expect(tab("Activity")).toHaveAttribute("tabindex", "-1");
		await page.keyboard.press("Tab");
		await expect(s.panel.getByRole("tabpanel")).toBeFocused();
	});
});
