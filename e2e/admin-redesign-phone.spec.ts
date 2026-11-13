import { expect, type Locator, test } from "@playwright/test";
import { loginAs } from "./helpers";

/**
 * The admin pages on a 390 px phone (SPEC.md sections 20.1 and 25.8): the
 * section control that replaces the rail, the Network mode switch stacked
 * under its title, the Settings section chips and the Users page's add
 * buttons are usable by touch and keyboard, each a target at least 44 px tall.
 */
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

const TARGET = 44;

async function height(locator: Locator): Promise<number> {
	const box = await locator.boundingBox();
	if (!box) throw new Error("no box");
	return box.height;
}

test("one section control names the page and opens every section as a list", async ({
	page,
}) => {
	await loginAs(page, "carol");
	await page.goto("/admin/users");
	const nav = page.getByRole("navigation", { name: "Administration" });
	const toggle = nav.getByRole("button", { name: "Section: Users" });
	await expect(toggle).toBeVisible({ timeout: 15_000 });
	expect(await height(toggle)).toBeGreaterThanOrEqual(TARGET);
	await expect(toggle).toHaveAttribute("aria-expanded", "false");
	// Folded, the section links take no room on the page.
	await expect(nav.getByRole("link", { name: "Network" })).toBeHidden();

	await toggle.tap();
	await expect(toggle).toHaveAttribute("aria-expanded", "true");
	const links = nav.getByRole("link");
	expect(await links.count()).toBeGreaterThan(5);
	for (const link of await links.all()) {
		await expect(link).toBeVisible();
		expect(await height(link)).toBeGreaterThanOrEqual(TARGET);
	}
	await expect(nav.getByRole("link", { name: "Users" })).toHaveAttribute(
		"aria-current",
		"page",
	);

	// Choosing a section goes there, folds the list and renames the control.
	await nav.getByRole("link", { name: "Network" }).tap();
	await expect(page).toHaveURL(/\/admin\/network$/);
	const network = nav.getByRole("button", { name: "Section: Network" });
	await expect(network).toHaveAttribute("aria-expanded", "false");
	await expect(nav.getByRole("link", { name: "Users" })).toBeHidden();

	// From the keyboard: Enter opens, Escape folds and returns focus to the control.
	await network.focus();
	await page.keyboard.press("Enter");
	await expect(network).toHaveAttribute("aria-expanded", "true");
	await page.keyboard.press("Tab");
	await expect(nav.getByRole("link").first()).toBeFocused();
	await page.keyboard.press("Escape");
	await expect(network).toHaveAttribute("aria-expanded", "false");
	await expect(network).toBeFocused();
});

test("the Network mode switch stacks under its title with full-width 44 px segments", async ({
	page,
}) => {
	await loginAs(page, "carol");
	await page.goto("/admin/network");
	const card = page.getByTestId("egress-mode-card");
	const mode = card.getByRole("group", { name: "Internet access from workspaces" });
	await expect(mode).toBeVisible({ timeout: 15_000 });
	const open = mode.getByRole("button", { name: "Open", exact: true });
	const allow = mode.getByRole("button", { name: "Allow-list" });

	const title = await card
		.getByRole("heading", { name: "Internet access from workspaces" })
		.boundingBox();
	const group = await mode.boundingBox();
	const cardBox = await card.boundingBox();
	const openBox = await open.boundingBox();
	const allowBox = await allow.boundingBox();
	if (!title || !group || !cardBox || !openBox || !allowBox) throw new Error("no box");
	// Stacked: under the title, not squeezed beside it.
	expect(group.y).toBeGreaterThanOrEqual(title.y + title.height - 1);
	// The two segments share one row that spans most of the card, each at least 44 px tall.
	expect(group.width).toBeGreaterThan(cardBox.width * 0.75);
	expect(Math.abs(openBox.y - allowBox.y)).toBeLessThan(2);
	expect(Math.abs(openBox.width - allowBox.width)).toBeLessThan(4);
	expect(openBox.height).toBeGreaterThanOrEqual(TARGET);
	expect(allowBox.height).toBeGreaterThanOrEqual(TARGET);
	// Nothing runs off the side of the phone.
	expect(group.x + group.width).toBeLessThanOrEqual(390);

	// A tap on the other mode asks first; dismissing changes nothing.
	const other = (await open.getAttribute("aria-pressed")) === "true" ? allow : open;
	const current = other === allow ? open : allow;
	await other.tap();
	const dialog = page.getByTestId("egress-mode-dialog");
	await expect(dialog).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(dialog).toBeHidden();
	await expect(current).toHaveAttribute("aria-pressed", "true");
	await expect(other).toHaveAttribute("aria-pressed", "false");
});

test("the Settings section chips are 44 px targets that jump to their section", async ({
	page,
}) => {
	await loginAs(page, "carol");
	await page.goto("/admin/settings");
	const index = page.getByRole("navigation", { name: "Settings sections" });
	await expect(index).toBeVisible({ timeout: 15_000 });
	const mail = index.getByRole("link", { name: "Email and alerts" });
	// Off the end of the scrolling row, it is still reachable.
	await mail.scrollIntoViewIfNeeded();
	// Every phone touch target is at least 44 px (SPEC.md section 25.8).
	expect(await height(mail)).toBeGreaterThanOrEqual(TARGET);
	await mail.tap();
	await expect(
		page.getByRole("heading", { name: "Email and alerts", level: 3 }),
	).toBeInViewport();
	// The index stays pinned at the top while the page scrolls under it.
	await expect(index).toBeInViewport();
});

test("Add user and More are 44 px targets, and More still opens Invite and Import", async ({
	page,
}) => {
	await loginAs(page, "carol");
	await page.goto("/admin/users");
	await expect(page.getByTestId("admin-accounts")).toBeVisible({ timeout: 15_000 });
	const add = page.getByRole("button", { name: "Add user…" });
	const more = page.getByRole("button", { name: "More", exact: true });
	expect(await height(add)).toBeGreaterThanOrEqual(TARGET);
	expect(await height(more)).toBeGreaterThanOrEqual(TARGET);

	await more.tap();
	const menu = page.getByRole("menu", { name: "More", exact: true });
	await expect(menu).toBeVisible();
	const box = await menu.boundingBox();
	if (!box) throw new Error("the menu has no box");
	// The menu stays on the phone's screen.
	expect(box.x).toBeGreaterThanOrEqual(0);
	expect(box.x + box.width).toBeLessThanOrEqual(390);
	await menu.getByRole("menuitem", { name: "Import from CSV…" }).tap();
	await expect(page.getByRole("dialog", { name: "Import from CSV" })).toBeVisible();
});
