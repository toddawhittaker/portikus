import { expect, type Locator, type Page, test } from "@playwright/test";
import { type Box, boxOf, frameLayout, ONE_ROW_WIDTH } from "./admin-frame";
import {
	createSignedInUser,
	expectNoViolations,
	loginAs,
	query,
	WEB_ORIGIN,
} from "./helpers";

/** The shortest a rail item may be: the small control height, above the 24 px target (WCAG 2.5.8). */
const RAIL_ITEM = 28;

/** The gap between two items of one group in the rail (`--space-0.5`). */
const ITEM_GAP = 2;

/** The WCAG 1.4.12 text spacing override, which makes every rail item taller. */
const TEXT_SPACING =
	"* { line-height: 1.5 !important; letter-spacing: 0.12em !important; word-spacing: 0.16em !important; } p { margin-bottom: 2em !important; }";

const ADMIN_TAB_NAMES = [
	"Users",
	"Health",
	"Logs",
	"Audit",
	"Agent usage",
	"Network",
	"Backups",
	"Workspace image",
	"Certificate",
	"Docker",
	"Sign-in",
	"Site address",
	"Settings",
	"Root shell",
];

/**
 * A tab's accessible name: its label, which the Health tab may follow with
 * how many items need attention.
 */
function tabName(name: string): RegExp {
	return new RegExp(`^${name}( ?, \\d+ items? needs? attention)?$`);
}

/** A tab's text: its label, then the Health tab's count when there is one. */
function tabText(name: string): RegExp {
	return new RegExp(`^${name}(\\d+, \\d+ items? needs? attention)?$`);
}

/** Whether the rail shows all it holds, with nothing cut off or scrolling sideways. */
async function railOverflow(page: Page) {
	return page.getByRole("navigation", { name: "Administration" }).evaluate((nav) => ({
		sideways: nav.scrollWidth > nav.clientWidth,
		down: nav.scrollHeight > nav.clientHeight,
	}));
}

/**
 * Each tab's name, and whether its label and the tab lie whole inside the
 * rail and the window: the rail never clips a name.
 */
async function tabsWhole(page: Page) {
	return page
		.getByRole("navigation", { name: "Administration" })
		.getByRole("link")
		.evaluateAll((links) =>
			links.map((link) => {
				const label = link.querySelector("span") as HTMLElement;
				const nav = link.closest("nav") as HTMLElement;
				const linkBox = link.getBoundingClientRect();
				const navBox = nav.getBoundingClientRect();
				const range = document.createRange();
				range.selectNodeContents(label);
				const text = range.getBoundingClientRect();
				return {
					name: label.textContent,
					whole:
						text.left >= linkBox.left &&
						text.right <= linkBox.right &&
						linkBox.left >= navBox.left &&
						linkBox.right <= navBox.right &&
						linkBox.right <= window.innerWidth,
				};
			}),
		);
}

/**
 * The tabs read top to bottom in document order, one under another in a
 * single column of one width, with no overlap and no more than the item gap
 * inside a group.
 */
function expectOneColumnInOrder(
	boxes: (Box & { group: number })[],
	expectedCount = ADMIN_TAB_NAMES.length,
) {
	expect(boxes).toHaveLength(expectedCount);
	for (let i = 1; i < boxes.length; i++) {
		const [before, after] = [boxes[i - 1], boxes[i]];
		if (!before || !after) throw new Error("a tab has no box");
		expect(after.x).toBeCloseTo(before.x, 0);
		expect(after.width).toBeCloseTo(before.width, 0);
		expect(after.y).toBeGreaterThanOrEqual(before.y + before.height - 0.5);
		if (after.group === before.group) {
			expect(after.y - (before.y + before.height)).toBeLessThanOrEqual(ITEM_GAP + 0.5);
		}
	}
}

/**
 * Each tab's box, with the rail's own scroll added back, so a box read
 * after the rail scrolls a tab into view compares with one read before.
 * `group` numbers the rail group the tab sits in.
 */
async function tabBoxes(page: Page): Promise<(Box & { group: number })[]> {
	// A web font swapping in between two reads would move every tab.
	await page.evaluate(() => document.fonts.ready);
	return page
		.getByRole("navigation", { name: "Administration" })
		.getByRole("link")
		.evaluateAll((links) => {
			const groups: Element[] = [];
			return links.map((link) => {
				const nav = link.closest("nav") as HTMLElement;
				const group = link.parentElement as Element;
				if (!groups.includes(group)) groups.push(group);
				const { x, y, width, height } = link.getBoundingClientRect();
				return {
					x: x + nav.scrollLeft,
					y: y + nav.scrollTop,
					width,
					height,
					group: groups.indexOf(group),
				};
			});
		});
}

/** The page gutter on each side of the frame (`--space-4`). */
const GUTTER = 16;

/**
 * Text and forms keep their own cap, however wide the frame is: about 72
 * characters for a line of text, and less than `widest` for a form.
 */
async function expectMeasure(locator: Locator, widest = 800): Promise<void> {
	const measure = await locator.evaluate((el) => ({
		cap: getComputedStyle(el).maxWidth,
		width: el.getBoundingClientRect().width,
	}));
	expect(measure.cap).toMatch(/px$/);
	expect(measure.width).toBeLessThanOrEqual(Number.parseFloat(measure.cap));
	expect(measure.width).toBeLessThan(widest);
}

/** 68rem: the Settings cards' column; a card puts a setting's text and its box side by side, so it is wider than one line. */
const SETTINGS_FORM_CAP = 68 * 16;

/** The admin frame every tab shares (SPEC.md section 20.1). */
test.describe("admin layout", () => {
	test.use({ viewport: { width: 1920, height: 1080 } });

	test("the frame fills the window less the gutters, text and forms keep their measure, and each tab has its own h2 and title", async ({
		page,
	}) => {
		await loginAs(page, "carol");
		await page.goto("/admin");

		const main = page.getByTestId("page-admin");
		await expect(main).toHaveAttribute("data-density", "compact", { timeout: 15_000 });
		const frame = await boxOf(page.getByTestId("admin-frame"));
		expect(frame.x).toBe(GUTTER);
		expect(frame.width).toBe(1920 - 2 * GUTTER);
		// The table takes the width; the intro keeps its reading measure.
		const content = await boxOf(page.getByTestId("admin-content"));
		const table = await boxOf(page.getByTestId("admin-accounts"));
		// The content's padding and the table's own border are all that sit beside it.
		expect(table.width).toBeGreaterThanOrEqual(content.width - 2 * 16 - 2);
		await expectMeasure(page.getByTestId("intro-admin-users"));
		// However wide the window, the content stops at its own cap beside the rail.
		await expectMeasure(page.getByTestId("admin-content"), 80 * 16 + 1);
		await page.getByTestId("admin-tab-settings").click();
		// The cards stop at their column's width, and each setting's sentence at its reading measure.
		const sections = await boxOf(page.getByTestId("settings-sections"));
		expect(sections.width).toBeLessThanOrEqual(SETTINGS_FORM_CAP + 1);
		await expectMeasure(page.locator("#settings-idleStopMinutes-desc"));

		for (const [tab, name] of [
			["users", "Users"],
			["audit", "Audit"],
			["health", "Health"],
			["settings", "Settings"],
		] as const) {
			await page.getByTestId(`admin-tab-${tab}`).click();
			await expect(
				main.getByRole("heading", { level: 2, name, exact: true }),
			).toBeVisible();
			await expect(page).toHaveTitle(`${name}, Administration, Portikus`);
		}
	});

	test("each tab has its own path, the back button moves between tabs, and an old ?tab= link redirects", async ({
		page,
	}) => {
		await loginAs(page, "carol");
		await page.goto("/admin");
		await expect(page).toHaveURL(/\/admin\/users$/, { timeout: 15_000 });

		await page.getByTestId("admin-tab-health").click();
		await expect(page).toHaveURL(/\/admin\/health$/);
		await page.getByTestId("admin-tab-settings").click();
		await expect(page).toHaveURL(/\/admin\/settings$/);
		await page.goBack();
		await expect(page).toHaveURL(/\/admin\/health$/);
		await expect(page.getByTestId("admin-tab-announce")).toHaveText("Health tab");
		await expect(page.getByTestId("admin-tab-health")).toHaveAttribute(
			"aria-current",
			"page",
		);

		// A reload of a deep path serves the page, not the API's JSON.
		await page.reload();
		await expect(page.getByTestId("admin-tab-health")).toHaveAttribute(
			"aria-current",
			"page",
			{
				timeout: 15_000,
			},
		);

		// The Users tab's old value was workspaces; other keys are kept.
		await page.goto("/admin?tab=audit&action=workspace.");
		await expect(page).toHaveURL(/\/admin\/audit\?action=workspace\.$/, {
			timeout: 15_000,
		});
		await page.goto("/admin?tab=workspaces");
		await expect(page).toHaveURL(/\/admin\/users$/, { timeout: 15_000 });
	});

	test("tabs read Users, Health, Logs, Audit, Agent usage, Network, Backups, Workspace image, Certificate, Docker, Settings, one under another with no gaps", async ({
		page,
	}) => {
		await loginAs(page, "carol");
		await page.goto("/admin");
		const nav = page.getByRole("navigation", { name: "Administration" });
		await expect(nav.getByRole("link")).toHaveText(ADMIN_TAB_NAMES.map(tabText), {
			timeout: 15_000,
		});
		expectOneColumnInOrder(await tabBoxes(page));
	});

	for (const width of [1920, ONE_ROW_WIDTH]) {
		test(`the header holds the mark, the context and the account, and the rail under it shows every tab whole at ${width} px`, async ({
			page,
			context,
		}) => {
			await page.setViewportSize({ width, height: 800 });
			// A long name and an unread badge: the worst case for the header's width.
			const { userId } = await createSignedInUser(context, "administrator");
			await query("update users set display_name = $2 where id = $1", [
				userId,
				"Maximiliana Konstantinopoulou-Vanderberg",
			]);
			const recorded = await page.request.post("/me/notifications", {
				data: { tone: "warning", title: "Disk nearly full", body: "" },
				headers: { origin: WEB_ORIGIN },
			});
			expect(recorded.status()).toBe(201);
			await page.goto("/admin/health");
			await expect(page.getByTestId("notifications-badge")).toHaveText("1", {
				timeout: 15_000,
			});
			const header = page.getByTestId("app-header");
			const nav = page.getByRole("navigation", { name: "Administration" });
			await expect(page.getByTestId("admin-tab-health")).toHaveAttribute(
				"aria-current",
				"page",
				{ timeout: 15_000 },
			);

			// The header is the mark, "Administration" and the account: no tabs.
			await expect(header.getByRole("navigation")).toHaveCount(0);
			await expect(header.getByRole("link", { name: /Portikus/ })).toBeVisible();
			await expect(header.getByText("Administration", { exact: true })).toBeVisible();
			await expect(page.getByTestId("me")).toHaveAccessibleName(
				/^Maximiliana Konstantinopoulou-Vanderberg, 1 unread notification$/,
			);
			const { headerBox, railBox, frameBox, mainBox, barBox } = await frameLayout(page);
			expect(headerBox.height).toBe(48);
			expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
				width,
			);
			const badge = await boxOf(page.getByTestId("notifications-badge"));
			expect(badge.x + badge.width).toBeLessThanOrEqual(width);

			// The rail sits right under the header, at the frame's start, down to the frame's foot.
			expect(railBox.y).toBeCloseTo(headerBox.y + headerBox.height, 0);
			expect(railBox.x).toBeCloseTo(frameBox.x, 0);
			expect(railBox.y + railBox.height).toBeCloseTo(frameBox.y + frameBox.height, 0);
			// The frame fills the window less the page gutter on each side,
			// and runs from the header to the status bar at the foot of the window.
			expect(frameBox.x).toBe(GUTTER);
			expect(frameBox.width).toBe(width - 2 * GUTTER);
			expect(frameBox.y + frameBox.height).toBeCloseTo(barBox.y, 0);
			expect(barBox.y + barBox.height).toBeCloseTo(800, 0);
			const lines = await page.getByTestId("admin-frame").evaluate((el) => {
				const style = getComputedStyle(el);
				return [style.borderLeftWidth, style.borderRightWidth, style.borderTopWidth];
			});
			// No side lines: the rail and the content mark out the frame.
			expect(lines).toEqual(["0px", "0px", "0px"]);
			// The content scrolls in the frame, beside the rail, from its top to the frame's end.
			expect(mainBox.y).toBeCloseTo(railBox.y, 0);
			expect(mainBox.x).toBeGreaterThanOrEqual(railBox.x + railBox.width);
			expect(mainBox.x + mainBox.width).toBeCloseTo(frameBox.x + frameBox.width, 0);
			expect(mainBox.height).toBeCloseTo(railBox.height, 0);

			// Every tab is in the one column, whole, with its icon, and the rail cuts nothing off.
			expect(await railOverflow(page)).toEqual({ sideways: false, down: false });
			expectOneColumnInOrder(await tabBoxes(page));
			expect(await tabsWhole(page)).toEqual(
				ADMIN_TAB_NAMES.map((name) => ({ name, whole: true })),
			);
			const tabs = await nav.getByRole("link").evaluateAll((links) =>
				links.map((link) => {
					const label = link.querySelector("span") as HTMLElement;
					const icon = link.querySelector("svg") as SVGElement;
					return {
						mask: getComputedStyle(label).maskImage,
						title: link.getAttribute("title"),
						iconHidden: icon.getAttribute("aria-hidden"),
						height: link.getBoundingClientRect().height,
					};
				}),
			);
			for (const tab of tabs) {
				expect(tab.mask).toBe("none");
				expect(tab.title).toBeNull();
				expect(tab.iconHidden).toBe("true");
				expect(tab.height).toBeGreaterThanOrEqual(RAIL_ITEM);
			}

			// The current tab has the selected ground, with an accent bar at its start edge.
			const look = await page.getByTestId("admin-tab-health").evaluate((el) => {
				const token = (name: string) => {
					const probe = document.createElement("span");
					probe.style.color = getComputedStyle(
						document.documentElement,
					).getPropertyValue(name);
					document.body.append(probe);
					const colour = getComputedStyle(probe).color;
					probe.remove();
					return colour;
				};
				const edge = getComputedStyle(el, "::before");
				const other = el.parentElement?.querySelector("a:not([aria-current])");
				return {
					background: getComputedStyle(el).backgroundColor,
					ground: token("--surface-selected"),
					otherBackground: other ? getComputedStyle(other).backgroundColor : "",
					edge: edge.backgroundColor,
					accent: token("--accent"),
					edgeWidth: edge.width,
				};
			});
			expect(look.background).toBe(look.ground);
			expect(look.otherBackground).toBe("rgba(0, 0, 0, 0)");
			expect(look.edge).toBe(look.accent);
			expect(look.edgeWidth).toBe("2px");
		});
	}

	for (const width of [1024, 900, 768]) {
		test(`at ${width} px the rail keeps every tab whole and in order, nothing scrolls sideways, and the account menu opens`, async ({
			page,
			context,
		}) => {
			await page.setViewportSize({ width, height: 800 });
			// A long name: the worst case for the header's width.
			const { userId } = await createSignedInUser(context, "administrator");
			await query("update users set display_name = $2 where id = $1", [
				userId,
				"Maximiliana Konstantinopoulou-Vanderberg",
			]);
			await page.goto("/admin/health");
			const nav = page.getByRole("navigation", { name: "Administration" });
			await expect(page.getByTestId("admin-tab-health")).toHaveAttribute(
				"aria-current",
				"page",
				{ timeout: 15_000 },
			);
			// The Root shell tab arrives with its status fetch; measure the full rail.
			await expect(nav.getByRole("link")).toHaveCount(ADMIN_TAB_NAMES.length, {
				timeout: 15_000,
			});

			const { headerBox, railBox, frameBox, mainBox } = await frameLayout(page);
			expect(headerBox.height).toBe(48);
			expect(frameBox.x).toBe(GUTTER);
			expect(frameBox.width).toBe(width - 2 * GUTTER);
			// The rail and the content share the frame side by side, the content keeping the larger part.
			expect(mainBox.y).toBeCloseTo(railBox.y, 0);
			expect(mainBox.x).toBeGreaterThanOrEqual(railBox.x + railBox.width);
			expect(mainBox.width).toBeGreaterThan(railBox.width);

			// One column, read top to bottom in document order, every name whole and nothing cut off.
			expect(await railOverflow(page)).toEqual({ sideways: false, down: false });
			expectOneColumnInOrder(await tabBoxes(page));
			expect(await tabsWhole(page)).toEqual(
				ADMIN_TAB_NAMES.map((name) => ({ name, whole: true })),
			);

			// The keyboard walks the tabs in the same order, across the groups.
			await nav.getByRole("link", { name: "Users", exact: true }).focus();
			for (const name of ADMIN_TAB_NAMES.slice(1)) {
				await page.keyboard.press("Tab");
				await expect(nav.getByRole("link", { name: tabName(name) })).toBeFocused();
			}

			// Neither the page nor the header scrolls sideways, on any tab.
			for (const name of ADMIN_TAB_NAMES) {
				const tab = nav.getByRole("link", { name: tabName(name) });
				await tab.click();
				await expect(tab).toHaveAttribute("aria-current", "page");
				expect(
					await page.evaluate(() => {
						const header = document.querySelector(
							"[data-testid=app-header]",
						) as HTMLElement;
						return {
							page: document.documentElement.scrollWidth,
							header: header.scrollWidth <= header.clientWidth,
						};
					}),
				).toEqual({ page: width, header: true });
			}

			// The account stays on screen and its menu opens.
			const me = page.getByTestId("me");
			const meBox = await boxOf(me);
			expect(meBox.x + meBox.width).toBeLessThanOrEqual(width);
			await me.click();
			await expect(page.getByRole("menuitem", { name: "Settings" })).toBeVisible();
		});
	}

	for (const scheme of ["light", "dark"] as const) {
		test(`at 768 px the admin page has no automatic violations (${scheme})`, async ({
			page,
		}) => {
			await page.emulateMedia({ colorScheme: scheme });
			await page.setViewportSize({ width: 768, height: 800 });
			await loginAs(page, "carol");
			await page.goto("/admin/users");
			// Only Carol's row, so the scan does not grow with the run's accounts.
			await page.getByTestId("admin-filter-text").fill("carol@example.edu");
			await expect(page.locator("[data-testid^=account-row-]")).toHaveCount(1, {
				timeout: 15_000,
			});
			await page
				.getByTestId("page-admin")
				.getByRole("button", { name: /^Show details for Carol Admin/ })
				.click();
			await expect(page.getByTestId("workspace-detail")).toBeVisible();
			await expectNoViolations(page);
		});
	}

	test("only the framed content scrolls: the header, the rail and the frame stay put", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 1280, height: 600 });
		await loginAs(page, "carol");
		await page.goto("/admin/audit");
		const main = page.getByTestId("page-admin");
		await expect(main.getByRole("heading", { level: 2, name: "Audit" })).toBeVisible({
			timeout: 15_000,
		});
		const before = await frameLayout(page);
		const scrolled = await main.evaluate((el) => {
			el.scrollTop = 400;
			return el.scrollTop;
		});
		expect(scrolled).toBeGreaterThan(0);
		const after = await frameLayout(page);
		expect(after.headerBox).toEqual(before.headerBox);
		expect(after.railBox).toEqual(before.railBox);
		expect(after.frameBox).toEqual(before.frameBox);
		// The window itself never scrolls.
		expect(
			await page.evaluate(() => ({
				y: window.scrollY,
				tall: document.documentElement.scrollHeight > window.innerHeight,
			})),
		).toEqual({ y: 0, tall: false });
	});

	test("the keyboard reaches the account, then the tabs in order, with a visible ring", async ({
		page,
	}) => {
		await loginAs(page, "carol");
		await page.goto("/admin/users");
		const nav = page.getByRole("navigation", { name: "Administration" });
		const users = nav.getByRole("link", { name: "Users", exact: true });
		await expect(users).toBeVisible({ timeout: 15_000 });
		await page.getByTestId("me").focus();
		// After the account button (and its unread badge, when there is one) come the tabs.
		for (let step = 0; step < 3; step++) {
			await page.keyboard.press("Tab");
			if (await users.evaluate((el) => el === document.activeElement)) break;
		}
		for (const name of ["Users", "Health", "Logs", "Audit", "Agent usage", "Network"]) {
			if (name !== "Users") await page.keyboard.press("Tab");
			const link = nav.getByRole("link", { name: tabName(name) });
			await expect(link).toBeFocused();
			const outline = await link.evaluate((el) => getComputedStyle(el).outlineStyle);
			expect(outline).toBe("solid");
		}
		await page.keyboard.press("Enter");
		await expect(page).toHaveURL(/\/admin\/network$/);
		await expect(nav.getByRole("link", { name: "Network" })).toHaveAttribute(
			"aria-current",
			"page",
		);
	});

	for (const scheme of ["light", "dark"] as const) {
		test(`with WCAG text spacing at 1024 px the rail keeps every tab whole and in order (${scheme})`, async ({
			page,
		}) => {
			await page.emulateMedia({ colorScheme: scheme });
			await page.setViewportSize({ width: 1024, height: 700 });
			await loginAs(page, "carol");
			await page.goto("/admin/health");
			const nav = page.getByRole("navigation", { name: "Administration" });
			await expect(page.getByTestId("admin-tab-health")).toHaveAttribute(
				"aria-current",
				"page",
				{ timeout: 15_000 },
			);
			await expect(nav.getByRole("link")).toHaveCount(ADMIN_TAB_NAMES.length, {
				timeout: 15_000,
			});
			await page.addStyleTag({ content: TEXT_SPACING });
			const { headerBox, railBox, mainBox } = await frameLayout(page);
			expect(mainBox.y).toBeCloseTo(railBox.y, 0);
			expect(mainBox.x).toBeGreaterThanOrEqual(railBox.x + railBox.width);
			expect(headerBox.height).toBe(48);
			expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
				1024,
			);
			// The taller items may scroll the rail down, but never sideways, and no name is cut.
			expect((await railOverflow(page)).sideways).toBe(false);
			const boxes = await tabBoxes(page);
			expectOneColumnInOrder(boxes);
			expect(await tabsWhole(page)).toEqual(
				ADMIN_TAB_NAMES.map((name) => ({ name, whole: true })),
			);
			// The rail's own rule marks it off from the content; the tabs draw no rules of their own.
			const rules = await nav.evaluate((el) => {
				const link = el.querySelector("a") as HTMLElement;
				return {
					tabTop: getComputedStyle(link).borderTopWidth,
					tabTall: link.getBoundingClientRect().height >= 28,
					railEnd: getComputedStyle(el).borderInlineEndWidth,
				};
			});
			expect(rules).toEqual({ tabTop: "0px", tabTall: true, railEnd: "1px" });

			// Choosing a tab low in the rail moves no tab.
			await nav.getByRole("link", { name: "Settings", exact: true }).click();
			await expect(nav.getByRole("link", { name: "Settings" })).toHaveAttribute(
				"aria-current",
				"page",
			);
			expect(await tabBoxes(page)).toEqual(boxes);

			// The keyboard walks the tabs in the same order, across the groups.
			await nav.getByRole("link", { name: "Users", exact: true }).focus();
			for (const name of ADMIN_TAB_NAMES.slice(1)) {
				await page.keyboard.press("Tab");
				await expect(nav.getByRole("link", { name: tabName(name) })).toBeFocused();
			}
			await expectNoViolations(page, "[data-testid=app-header]");
			await expectNoViolations(page, "[data-testid=admin-frame] > nav");
		});
	}

	test("on the administrator help no tab is current or looks selected", async ({
		page,
	}) => {
		await loginAs(page, "carol");
		await page.goto("/admin/help");
		const nav = page.getByRole("navigation", { name: "Administration" });
		await expect(nav.getByRole("link")).toHaveCount(ADMIN_TAB_NAMES.length, {
			timeout: 15_000,
		});
		await expect(nav.locator("[aria-current]")).toHaveCount(0);
		const backgrounds = await nav
			.getByRole("link")
			.evaluateAll((links) =>
				links.map((link) => getComputedStyle(link).backgroundColor),
			);
		expect(new Set(backgrounds)).toEqual(new Set(["rgba(0, 0, 0, 0)"]));
	});

	test("in forced colours the current tab keeps its start bar", async ({ page }) => {
		await page.emulateMedia({ forcedColors: "active" });
		await loginAs(page, "carol");
		await page.goto("/admin/health");
		const current = page.getByTestId("admin-tab-health");
		await expect(current).toHaveAttribute("aria-current", "page", { timeout: 15_000 });
		const bar = await current.evaluate((el) => {
			const probe = document.createElement("span");
			probe.style.color = "Highlight";
			document.body.append(probe);
			const highlight = getComputedStyle(probe).color;
			probe.remove();
			const edge = getComputedStyle(el, "::before");
			return { background: edge.backgroundColor, width: edge.width, highlight };
		});
		expect(bar.width).toBe("2px");
		expect(bar.background).toBe(bar.highlight);
		expect(bar.background).not.toBe("rgba(0, 0, 0, 0)");
	});

	test("in forced colours the current tab is bolder, and choosing a tab moves no tab", async ({
		page,
	}) => {
		await page.emulateMedia({ forcedColors: "active" });
		await loginAs(page, "carol");
		await page.goto("/admin/health");
		const nav = page.getByRole("navigation", { name: "Administration" });
		await expect(page.getByTestId("admin-tab-health")).toHaveAttribute(
			"aria-current",
			"page",
			{ timeout: 15_000 },
		);
		const weights = () =>
			nav
				.getByRole("link")
				.evaluateAll((links) =>
					links.map((link) => Number(getComputedStyle(link).fontWeight)),
				);
		const before = await weights();
		const health = ADMIN_TAB_NAMES.indexOf("Health");
		expect(before[health]).toBeGreaterThanOrEqual(600);
		for (const [index, weight] of before.entries()) {
			if (index !== health) expect(weight).toBeLessThan(before[health]);
		}
		const boxes = await tabBoxes(page);
		await nav.getByRole("link", { name: "Workspace image", exact: true }).click();
		await expect(
			nav.getByRole("link", { name: "Workspace image", exact: true }),
		).toHaveAttribute("aria-current", "page");
		expect(await tabBoxes(page)).toEqual(boxes);
	});

	for (const scheme of ["light", "dark"] as const) {
		test(`the frame has no side lines and the tabs no rules between them (${scheme})`, async ({
			page,
		}) => {
			await page.emulateMedia({ colorScheme: scheme });
			await loginAs(page, "carol");
			await page.goto("/admin/users");
			const frame = page.getByTestId("admin-frame");
			await expect(frame).toBeVisible({ timeout: 15_000 });
			const look = await frame.evaluate((el) => {
				const style = getComputedStyle(el);
				const tab = getComputedStyle(el.querySelector("nav a") as Element);
				return {
					sides: [style.borderInlineStartWidth, style.borderInlineEndWidth],
					between: tab.borderInlineEndWidth,
				};
			});
			expect(look).toEqual({ sides: ["0px", "0px"], between: "0px" });
			await expectNoViolations(page, "[data-testid=admin-frame] > nav");
		});
	}

	for (const scheme of ["light", "dark"] as const) {
		test(`the admin header and the tab strip have no automatic violations (${scheme})`, async ({
			page,
		}) => {
			await page.emulateMedia({ colorScheme: scheme });
			await page.setViewportSize({ width: 1024, height: 768 });
			await loginAs(page, "carol");
			await page.goto("/admin/audit");
			await expect(
				page.getByRole("navigation", { name: "Administration" }).getByRole("link", {
					name: "Audit",
				}),
			).toHaveAttribute("aria-current", "page", { timeout: 15_000 });
			await page.getByRole("link", { name: "Logs", exact: true }).focus();
			await expectNoViolations(page, "[data-testid=app-header]");
			await expectNoViolations(page, "[data-testid=admin-frame] > nav");
		});
	}
});
