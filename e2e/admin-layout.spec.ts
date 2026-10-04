import { randomUUID } from "node:crypto";
import { expect, type Locator, type Page, test } from "@playwright/test";
import {
	createSignedInUser,
	expectNoViolations,
	loginAs,
	MOCK_ISSUER,
	query,
	WEB_ORIGIN,
} from "./helpers";

/** One row of the tab strip: a tab and the rule above it, as the workspace strip. */
const TAB_ROW = 36;

/** The strip with `rows` rows: its first rule lies on the header's line, and its own rule closes the last row. */
const stripHeight = (rows: number) => rows * TAB_ROW + 1;

/** The WCAG 1.4.12 text spacing override, which widens the tabs past one row at 1024 px. */
const TEXT_SPACING =
	"* { line-height: 1.5 !important; letter-spacing: 0.12em !important; word-spacing: 0.16em !important; } p { margin-bottom: 2em !important; }";

const ADMIN_TAB_NAMES = [
	"Users",
	"Health",
	"Logs",
	"Audit",
	"Network",
	"Backups",
	"Workspace image",
	"Certificate",
	"Docker",
	"Settings",
];

type Box = { x: number; y: number; width: number; height: number };

async function boxOf(locator: Locator): Promise<Box> {
	const box = await locator.boundingBox();
	if (!box) throw new Error("an element of the admin frame has no box");
	return box;
}

/** The header, the tab strip, the frame and the scrolling content, as drawn now. */
async function frameLayout(page: Page) {
	return {
		headerBox: await boxOf(page.getByTestId("app-header")),
		stripBox: await boxOf(page.getByRole("navigation", { name: "Administration" })),
		frameBox: await boxOf(page.getByTestId("admin-frame")),
		mainBox: await boxOf(page.getByTestId("page-admin")),
	};
}

async function tabBoxes(page: Page): Promise<Box[]> {
	return page
		.getByRole("navigation", { name: "Administration" })
		.getByRole("link")
		.evaluateAll((links) =>
			links.map((link) => {
				const { x, y, width, height } = link.getBoundingClientRect();
				return { x, y, width, height };
			}),
		);
}

/** A panel kept in view beside a long list is capped to what the framed content shows, less its padding. */
async function expectFitsScroller(panel: Locator): Promise<void> {
	const fit = await panel.evaluate((el) => {
		const main = document.querySelector("[data-testid=page-admin]") as HTMLElement;
		return {
			max: Number.parseFloat(getComputedStyle(el).maxHeight),
			room: main.clientHeight - 48,
			height: el.getBoundingClientRect().height,
		};
	});
	expect(fit.max).toBeCloseTo(fit.room, 0);
	expect(fit.height).toBeLessThanOrEqual(fit.max + 0.5);
}

/** The admin frame every tab shares (SPEC.md section 20.1). */
test.describe("admin layout", () => {
	test.use({ viewport: { width: 1920, height: 1080 } });

	test("content is capped at 1440 px, compact, and each tab has its own h2 and title", async ({
		page,
	}) => {
		await loginAs(page, "carol");
		await page.goto("/admin");

		const main = page.getByTestId("page-admin");
		await expect(main).toHaveAttribute("data-density", "compact", { timeout: 15_000 });
		const box = await page.getByTestId("admin-content").boundingBox();
		expect(box?.width).toBeLessThanOrEqual(1440);
		expect(box?.width).toBeGreaterThan(1400);

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

	test("tabs read Users, Health, Logs, Audit, Network, Backups, Workspace image, Certificate, Docker, Settings, side by side with no gaps", async ({
		page,
	}) => {
		await loginAs(page, "carol");
		await page.goto("/admin");
		const nav = page.getByRole("navigation", { name: "Administration" });
		await expect(nav.getByRole("link")).toHaveText(ADMIN_TAB_NAMES, {
			timeout: 15_000,
		});
		const boxes = await tabBoxes(page);
		for (let i = 1; i < boxes.length; i++) {
			const [before, after] = [boxes[i - 1], boxes[i]];
			if (!before || !after) throw new Error("a tab has no box");
			expect(after.x).toBeCloseTo(before.x + before.width, 0);
		}
	});

	for (const width of [1920, 1366, 1024]) {
		test(`the header holds the mark, the context and the account, and the strip under it shows every tab whole at ${width} px`, async ({
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
			await expect(nav.getByRole("link", { name: "Health" })).toHaveAttribute(
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
			const { headerBox, stripBox, frameBox, mainBox } = await frameLayout(page);
			expect(headerBox.height).toBe(48);
			expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
				width,
			);
			const badge = await boxOf(page.getByTestId("notifications-badge"));
			expect(badge.x + badge.width).toBeLessThanOrEqual(width);

			// The strip sits right under the header, one tab row high, between the frame's lines.
			expect(stripBox.y).toBeCloseTo(headerBox.y + headerBox.height - 1, 0);
			expect(stripBox.height).toBe(stripHeight(1));
			expect(stripBox.x).toBeCloseTo(frameBox.x + 1, 0);
			expect(stripBox.x + stripBox.width).toBeCloseTo(
				frameBox.x + frameBox.width - 1,
				0,
			);
			// The frame is centred, at most 1440 px, with at least the page gutter outside it,
			// and runs from the header to the foot of the window.
			expect(frameBox.width).toBeLessThanOrEqual(1440);
			expect(frameBox.x).toBeGreaterThanOrEqual(16);
			expect(frameBox.x).toBeCloseTo((width - frameBox.width) / 2, 0);
			expect(frameBox.y + frameBox.height).toBeCloseTo(800, 0);
			const lines = await page.getByTestId("admin-frame").evaluate((el) => {
				const style = getComputedStyle(el);
				return [style.borderLeftWidth, style.borderRightWidth, style.borderTopWidth];
			});
			expect(lines).toEqual(["1px", "1px", "0px"]);
			// The content scrolls in the frame, under the strip.
			expect(mainBox.y).toBeCloseTo(stripBox.y + stripBox.height, 0);
			expect(mainBox.x).toBeCloseTo(stripBox.x, 0);
			expect(mainBox.width).toBeCloseTo(stripBox.width, 0);

			// Every tab is on the one row, with its icon and its whole name.
			const tabs = await nav.getByRole("link").evaluateAll((links) =>
				links.map((link) => {
					const label = link.querySelector("span") as HTMLElement;
					const icon = link.querySelector("svg") as SVGElement;
					const linkBox = link.getBoundingClientRect();
					const range = document.createRange();
					range.selectNodeContents(label);
					const text = range.getBoundingClientRect();
					return {
						name: label.textContent,
						top: linkBox.top,
						whole: text.left >= linkBox.left && text.right <= linkBox.right,
						mask: getComputedStyle(label).maskImage,
						title: link.getAttribute("title"),
						iconHidden: icon.getAttribute("aria-hidden"),
					};
				}),
			);
			expect(new Set(tabs.map((tab) => tab.top)).size).toBe(1);
			for (const tab of tabs) {
				expect({ name: tab.name, whole: tab.whole }).toEqual({
					name: tab.name,
					whole: true,
				});
				expect(tab.mask).toBe("none");
				expect(tab.title).toBeNull();
				expect(tab.iconHidden).toBe("true");
			}

			// The current tab has the workspace's selected-tab look: raised, with an accent top edge.
			const look = await nav.getByRole("link", { name: "Health" }).evaluate((el) => {
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
					raised: token("--surface-raised"),
					otherBackground: other ? getComputedStyle(other).backgroundColor : "",
					edge: edge.backgroundColor,
					accent: token("--accent"),
					edgeHeight: edge.height,
				};
			});
			expect(look.background).toBe(look.raised);
			expect(look.otherBackground).toBe("rgba(0, 0, 0, 0)");
			expect(look.edge).toBe(look.accent);
			expect(look.edgeHeight).toBe("2px");
		});
	}

	test("only the framed content scrolls: the header, the strip and the frame stay put", async ({
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
		expect(after.stripBox).toEqual(before.stripBox);
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
		for (const name of ["Users", "Health", "Logs", "Audit", "Network"]) {
			if (name !== "Users") await page.keyboard.press("Tab");
			const link = nav.getByRole("link", { name, exact: true });
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
		test(`with WCAG text spacing at 1024 px the tabs wrap to two rows that keep their order (${scheme})`, async ({
			page,
		}) => {
			await page.emulateMedia({ colorScheme: scheme });
			await page.setViewportSize({ width: 1024, height: 700 });
			await loginAs(page, "carol");
			await page.goto("/admin/health");
			const nav = page.getByRole("navigation", { name: "Administration" });
			await expect(nav.getByRole("link", { name: "Health" })).toHaveAttribute(
				"aria-current",
				"page",
				{ timeout: 15_000 },
			);
			await page.addStyleTag({ content: TEXT_SPACING });
			const { headerBox, stripBox, mainBox } = await frameLayout(page);
			expect(stripBox.height).toBe(stripHeight(2));
			expect(mainBox.y).toBeCloseTo(stripBox.y + stripBox.height, 0);
			expect(headerBox.height).toBe(48);
			expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
				1024,
			);
			// Reading order, top row first then left to right, is the document order.
			const boxes = await tabBoxes(page);
			expect(new Set(boxes.map((box) => box.y)).size).toBe(2);
			const reading = [...boxes].sort((a, b) => a.y - b.y || a.x - b.x);
			expect(reading).toEqual(boxes);
			// Each tab draws the rule above its row, and the strip's own rule closes the last row.
			const rules = await nav.evaluate((el) => {
				const link = el.querySelector("a") as HTMLElement;
				return {
					tabTop: getComputedStyle(link).borderTopWidth,
					tabHeight: link.getBoundingClientRect().height,
					stripBottom: getComputedStyle(el).borderBottomWidth,
				};
			});
			expect(rules).toEqual({ tabTop: "1px", tabHeight: TAB_ROW, stripBottom: "1px" });

			// Choosing a tab on the second row moves nothing.
			await nav.getByRole("link", { name: "Settings", exact: true }).click();
			await expect(nav.getByRole("link", { name: "Settings" })).toHaveAttribute(
				"aria-current",
				"page",
			);
			expect(await tabBoxes(page)).toEqual(boxes);

			// The keyboard walks the tabs in the same order, across the row break.
			await nav.getByRole("link", { name: "Users", exact: true }).focus();
			for (const name of ADMIN_TAB_NAMES.slice(1)) {
				await page.keyboard.press("Tab");
				await expect(nav.getByRole("link", { name, exact: true })).toBeFocused();
			}
			await expectNoViolations(page, "[data-testid=app-header]");
			await expectNoViolations(page, "[data-testid=admin-frame] > nav");
		});
	}

	for (const rows of [1, 2]) {
		test(`the Users detail panel fits the framed content with ${rows === 1 ? "one tab row" : "two tab rows"}`, async ({
			page,
		}) => {
			await page.setViewportSize({ width: 1024, height: 600 });
			await loginAs(page, "carol");
			await page.goto("/admin/users");
			await page
				.getByTestId("page-admin")
				.getByRole("button", { name: /^Show details for Carol Admin/ })
				.click({ timeout: 15_000 });
			if (rows === 2) await page.addStyleTag({ content: TEXT_SPACING });
			expect((await frameLayout(page)).stripBox.height).toBe(stripHeight(rows));
			const panel = page.getByTestId("workspace-detail");
			await expect(panel).toBeVisible();
			await expectFitsScroller(panel);
		});
	}

	test("the Network test panel fits the framed content with one tab row and with two", async ({
		page,
	}) => {
		// Wide enough for the panel to sit beside the lists.
		await page.setViewportSize({ width: 1440, height: 600 });
		await loginAs(page, "carol");
		await page.goto("/admin/network");
		const panel = page.getByRole("region", { name: "Test a host and refused names" });
		await expect(panel).toBeVisible({ timeout: 15_000 });
		expect(await panel.evaluate((el) => getComputedStyle(el).position)).toBe("sticky");
		expect((await frameLayout(page)).stripBox.height).toBe(stripHeight(1));
		await expectFitsScroller(panel);
		// Wider tabs force a second row here; what wraps them does not matter to the panel.
		await page.addStyleTag({
			content:
				"[data-testid=admin-frame] > nav > a { padding-inline: 48px !important; }",
		});
		expect((await frameLayout(page)).stripBox.height).toBe(stripHeight(2));
		await expectFitsScroller(panel);
	});

	test("on the administrator help no tab is current or looks selected", async ({
		page,
	}) => {
		await loginAs(page, "carol");
		await page.goto("/admin/help");
		const nav = page.getByRole("navigation", { name: "Administration" });
		await expect(nav.getByRole("link")).toHaveCount(10, { timeout: 15_000 });
		await expect(nav.locator("[aria-current]")).toHaveCount(0);
		const backgrounds = await nav
			.getByRole("link")
			.evaluateAll((links) =>
				links.map((link) => getComputedStyle(link).backgroundColor),
			);
		expect(new Set(backgrounds)).toEqual(new Set(["rgba(0, 0, 0, 0)"]));
	});

	test("in forced colours the current tab keeps its top bar", async ({ page }) => {
		await page.emulateMedia({ forcedColors: "active" });
		await loginAs(page, "carol");
		await page.goto("/admin/health");
		const current = page
			.getByRole("navigation", { name: "Administration" })
			.getByRole("link", { name: "Health", exact: true });
		await expect(current).toHaveAttribute("aria-current", "page", { timeout: 15_000 });
		const bar = await current.evaluate((el) => {
			const probe = document.createElement("span");
			probe.style.color = "Highlight";
			document.body.append(probe);
			const highlight = getComputedStyle(probe).color;
			probe.remove();
			const edge = getComputedStyle(el, "::before");
			return { background: edge.backgroundColor, height: edge.height, highlight };
		});
		expect(bar.height).toBe("2px");
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
		await expect(
			nav.getByRole("link", { name: "Health", exact: true }),
		).toHaveAttribute("aria-current", "page", { timeout: 15_000 });
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
		test(`the frame's side lines use the strong line colour (${scheme})`, async ({
			page,
		}) => {
			await page.emulateMedia({ colorScheme: scheme });
			await loginAs(page, "carol");
			await page.goto("/admin/users");
			const frame = page.getByTestId("admin-frame");
			await expect(frame).toBeVisible({ timeout: 15_000 });
			const lines = await frame.evaluate((el) => {
				const probe = document.createElement("span");
				probe.style.color = "var(--line-strong)";
				el.append(probe);
				const strong = getComputedStyle(probe).color;
				probe.remove();
				const style = getComputedStyle(el);
				return {
					start: style.borderInlineStartColor,
					end: style.borderInlineEndColor,
					width: style.borderInlineStartWidth,
					strong,
				};
			});
			expect(lines.width).toBe("1px");
			expect(lines.start).toBe(lines.strong);
			expect(lines.end).toBe(lines.strong);
			expect(lines.strong).toBe(
				scheme === "light" ? "rgb(138, 131, 117)" : "rgb(127, 120, 108)",
			);
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

	test("a secondary button shows its border", async ({ page }) => {
		await loginAs(page, "carol");
		await page.goto("/admin/audit");
		const clear = page.getByTestId("audit-filter-clear");
		await expect(clear).toBeVisible({ timeout: 15_000 });
		const color = await clear.evaluate((el) => getComputedStyle(el).borderTopColor);
		expect(color).not.toBe("rgba(0, 0, 0, 0)");
		expect(color).not.toBe("transparent");
	});

	test("the Audit table header stays in view under the tab strip when the content scrolls", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 1280, height: 600 });
		const workspaceId = randomUUID();
		await query(
			`insert into audit_events (actor, target, action, result, metadata, at)
			 select 'system', $1, 'workspace.stop_requested', 'success', '{}'::jsonb,
			        now() - make_interval(secs => 50 - n)
			 from generate_series(1, 50) as n order by n`,
			[workspaceId],
		);
		await loginAs(page, "carol");
		await page.goto(`/admin/audit?workspace=${workspaceId}`);

		const table = page.getByTestId("audit-table");
		await expect(table.locator("tbody tr")).toHaveCount(50, { timeout: 15_000 });
		const main = page.getByTestId("page-admin");
		await main.evaluate((el) => el.scrollBy(0, 800));

		const header = table.locator("thead th").first();
		const mainBox = await main.boundingBox();
		const headerBox = await header.boundingBox();
		expect(mainBox).not.toBeNull();
		expect(headerBox).not.toBeNull();
		if (!mainBox || !headerBox) return;
		// Stuck at <main>'s top edge, right under the tab strip, so no row shows above it.
		expect(Math.abs(headerBox.y - mainBox.y)).toBeLessThanOrEqual(1);
		const strip = await boxOf(page.getByRole("navigation", { name: "Administration" }));
		expect(Math.abs(headerBox.y - (strip.y + strip.height))).toBeLessThanOrEqual(1);
		const firstRow = await table.locator("tbody tr").first().boundingBox();
		expect(firstRow?.y ?? 0).toBeLessThan(mainBox.y);
	});

	test("Shift+Tab up a long Users list never hides the focused row under the header", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 1280, height: 600 });
		const tag = randomUUID().slice(0, 8);
		await query(
			`insert into users (oidc_issuer, oidc_subject, email, display_name, role, last_login_at)
			 select $1, 'e2e-' || $2 || '-' || n, 'focus-' || $2 || '-' || n || '@example.edu',
			        'Focus ' || $2 || ' ' || lpad(n::text, 2, '0'), 'student', now()
			 from generate_series(1, 40) as n`,
			[MOCK_ISSUER, tag],
		);
		await loginAs(page, "carol");
		await page.goto("/admin");
		const table = page.getByTestId("admin-accounts");
		await expect(table).toBeVisible({ timeout: 15_000 });
		await page.getByTestId("admin-filter-text").fill(`Focus ${tag}`);
		const rows = page.locator("[data-testid^=account-row-]");
		await expect(rows).toHaveCount(40);

		await rows
			.last()
			.getByRole("button", { name: /^Show details for/ })
			.focus();
		const header = table.locator("thead th").first();
		const firstId = await rows
			.first()
			.getByRole("button", { name: /^Show details for/ })
			.getAttribute("id");
		// Press until the first row's name has focus, however many stops a row has.
		let checked = 0;
		let reachedTop = false;
		for (let step = 0; step < 200 && !reachedTop; step++) {
			await page.keyboard.press("Shift+Tab");
			const focused = await page.evaluate(() => {
				const el = document.activeElement as HTMLElement | null;
				return el?.tagName === "BUTTON" && el.id
					? { id: el.id, top: el.getBoundingClientRect().top }
					: null;
			});
			if (focused === null) continue;
			const headerBox = await header.boundingBox();
			if (!headerBox) throw new Error("the header has no box");
			expect(focused.top).toBeGreaterThanOrEqual(headerBox.y + headerBox.height - 1);
			checked++;
			reachedTop = focused.id === firstId;
		}
		// The walk really reached every row above the last, up to the first.
		expect(reachedTop).toBe(true);
		expect(checked).toBeGreaterThanOrEqual(39);
	});
});
