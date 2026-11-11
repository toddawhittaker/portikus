/**
 * The workspace and the admin area in a 560 px window (SPEC.md sections 8.1,
 * 20.1 and 25.8): the page never scrolls sideways, the workspace's side panes
 * are drawers, every key control is reachable by keyboard and on screen, and
 * axe finds no violations in either theme. Wide windows keep the three panes
 * side by side. Short windows (320 by 256, 640 by 360) keep each drawer's
 * controls uncovered, and each admin table's box takes focus to scroll by keyboard.
 */
import { appendFileSync } from "node:fs";
import {
	type BrowserContext,
	expect,
	type Locator,
	type Page,
	test,
} from "@playwright/test";
import {
	apiLoginAs,
	createProject,
	createStudent,
	expectConnected,
	expectNoViolations,
	loginAs,
	seedFile,
	terminalIds,
	workspacePath,
	workTabs,
} from "./helpers";
import { E2E_JOURNAL_FILE } from "./journal-file";

const NARROW = { width: 560, height: 800 };

/** A long name with an unbroken run, the worst case for a narrow pane. */
const LONG_NAME = "Narrow layout Supercalifragilisticexpialidociousprojectname";

async function expectNoPageScrollSideways(page: Page): Promise<void> {
	const widths = await page.evaluate(() => ({
		scroll: document.documentElement.scrollWidth,
		client: document.documentElement.clientWidth,
	}));
	expect(widths.scroll).toBeLessThanOrEqual(widths.client);
}

async function boxOf(locator: Locator) {
	const box = await locator.boundingBox();
	if (!box) throw new Error("the element has no box");
	return box;
}

/** Put focus back at the start of the page, so the next Tab is the first stop. */
async function fromTop(page: Page): Promise<void> {
	await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

/**
 * Tab until focus reaches `target`, checking that every stop on the way sits
 * inside the window's width, so nothing focusable is pushed off the side.
 */
async function tabTo(page: Page, target: Locator, limit = 80): Promise<void> {
	const width = page.viewportSize()?.width ?? NARROW.width;
	for (let step = 0; step < limit; step += 1) {
		await page.keyboard.press("Tab");
		const stop = await page.evaluate(() => {
			const el = document.activeElement;
			if (!el || el === document.body) return null;
			const { left, right } = el.getBoundingClientRect();
			return { left, right, name: el.outerHTML.slice(0, 120) };
		});
		if (stop) {
			expect(stop.left, stop.name).toBeGreaterThanOrEqual(-1);
			expect(stop.right, stop.name).toBeLessThanOrEqual(width + 1);
		}
		if (await target.evaluate((el) => el === document.activeElement)) return;
	}
	throw new Error(`Tab never reached ${target}`);
}

/** The header buttons that open the side panes as drawers below 56rem (SPEC.md section 8.1). */
function projectsButton(page: Page): Locator {
	return page.getByRole("button", { name: "Projects", exact: true });
}
function filesButton(page: Page): Locator {
	return page.getByRole("button", { name: "Files", exact: true });
}

async function openDrawer(page: Page, name: "Projects" | "Files"): Promise<void> {
	await (name === "Projects" ? projectsButton(page) : filesButton(page)).click();
	const dialog = page.getByRole("dialog", { name });
	await expect(dialog).toBeVisible();
	// Until the slide in ends, its controls sit partly off screen.
	const width = page.viewportSize()?.width ?? NARROW.width;
	await expect
		.poll(async () => {
			const box = await boxOf(dialog);
			return Math.round(name === "Projects" ? box.x : box.x + box.width - width);
		})
		.toBe(0);
}

/** Escape closes the open drawer; a first press may only close a focused icon button's tooltip. */
async function closeDrawer(page: Page): Promise<void> {
	const open = page.getByRole("dialog");
	await page.keyboard.press("Escape");
	if (await open.isVisible()) await page.keyboard.press("Escape");
	await expect(open).toBeHidden();
}

test.describe("the workspace at 560 px", () => {
	test.use({ viewport: NARROW });

	test("the work area fills the width with no sideways scroll, and Tab reaches each pane's controls", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const project = await createProject(student.workspaceId, { name: LONG_NAME });
		await page.goto(workspacePath(student.workspaceId, project.id));
		await expect(workTabs(page)).toBeVisible({ timeout: 15_000 });
		await expectNoPageScrollSideways(page);

		const work = await boxOf(page.getByRole("main", { name: "Work area" }));
		expect(work.x).toBe(0);
		expect(work.width).toBe(NARROW.width);
		// The side panes are drawers, closed until asked for.
		await expect(page.getByRole("navigation", { name: "Projects" })).toBeHidden();
		await expect(page.locator(".pk-right-pane")).toBeHidden();
		await expect(
			page.getByRole("separator", { name: "Resize project list" }),
		).toBeHidden();
		await expect(
			page.getByRole("separator", { name: "Resize file tree" }),
		).toBeHidden();

		// From the top of the page, by keyboard only: the Projects drawer, the
		// work area, the Files drawer's tabs and the status bar.
		await fromTop(page);
		await tabTo(page, projectsButton(page));
		await page.keyboard.press("Enter");
		await tabTo(page, page.getByRole("button", { name: "New project" }));
		await closeDrawer(page);
		await expect(projectsButton(page)).toBeFocused();
		await tabTo(page, filesButton(page));
		await page.keyboard.press("Enter");
		await tabTo(page, page.getByRole("tab", { name: "Files" }));
		await page.keyboard.press("ArrowRight");
		await expect(page.getByRole("tab", { name: "Checks" })).toBeFocused();
		await page.keyboard.press("ArrowLeft");
		await closeDrawer(page);
		await expect(filesButton(page)).toBeFocused();

		await page.getByTestId("empty-open-terminal").focus();
		await page.keyboard.press("Enter");
		await expect
			.poll(async () => (await terminalIds(student.workspaceId, project.id)).length)
			.toBe(1);
		const [terminal] = await terminalIds(student.workspaceId, project.id);
		if (!terminal) throw new Error("the terminal row was not created");
		await expectConnected(page, terminal);
		await expectNoPageScrollSideways(page);
	});

	for (const colorScheme of ["light", "dark"] as const) {
		test(`the narrow workspace has no automatic accessibility violations (${colorScheme})`, async ({
			page,
			context,
		}) => {
			await page.emulateMedia({ colorScheme });
			const student = await createStudent(context);
			const project = await createProject(student.workspaceId, { name: LONG_NAME });
			await page.goto(workspacePath(student.workspaceId, project.id));
			await expect(workTabs(page)).toBeVisible({ timeout: 15_000 });
			await expectNoViolations(page);
			await openDrawer(page, "Files");
			await expect(page.getByRole("tab", { name: "Files" })).toBeVisible();
			await expectNoViolations(page);
			await page.screenshot({
				path: `screenshots/narrow-workspace-${colorScheme}.png`,
			});
		});
	}

	test("a narrow visit leaves the wide layout's pane widths alone", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const project = await createProject(student.workspaceId, { name: "Wide again" });
		await page.goto(workspacePath(student.workspaceId, project.id));
		await expect(workTabs(page)).toBeVisible({ timeout: 15_000 });
		await page.setViewportSize({ width: 1440, height: 900 });
		await page.reload();
		await expect(workTabs(page)).toBeVisible({ timeout: 15_000 });

		const projects = await boxOf(page.getByRole("navigation", { name: "Projects" }));
		const files = await boxOf(page.locator(".pk-right-pane"));
		// A wide window starts both side panes wider.
		expect(Math.round(projects.width)).toBe(264);
		expect(Math.round(files.width)).toBe(360);
		expect(files.y).toBe(projects.y);
		await expect(
			page.getByRole("separator", { name: "Resize project list" }),
		).toBeVisible();
		await page.screenshot({ path: "screenshots/narrow-workspace-wide-1440.png" });

		// Under the old 1024 px floor but wide enough for both side panes at
		// their default widths beside the work area's minimum.
		await page.setViewportSize({ width: 900, height: 900 });
		// Loaded at this width; a window narrowed live shrinks the panes in proportion.
		await page.reload();
		await expect(workTabs(page)).toBeVisible({ timeout: 15_000 });
		await expect(
			page.getByRole("separator", { name: "Resize file tree" }),
		).toBeVisible();
		await expectNoPageScrollSideways(page);
		const middle = await boxOf(page.getByRole("main", { name: "Work area" }));
		expect(middle.width).toBeGreaterThanOrEqual(360);
		const right = await boxOf(page.locator(".pk-right-pane"));
		expect(right.y).toBe(middle.y);
		expect(Math.round(right.width)).toBe(280);
		await page.screenshot({ path: "screenshots/narrow-workspace-900.png" });

		// Just under that, the side panes become drawers.
		await page.setViewportSize({ width: 880, height: 900 });
		await expect(
			page.getByRole("separator", { name: "Resize file tree" }),
		).toBeHidden();
		await expectNoPageScrollSideways(page);
	});
});

/** Short windows: a phone held sideways, and the 320 by 256 of WCAG 1.4.10 reflow. */
const SHORT = [
	{ width: 320, height: 256 },
	{ width: 640, height: 360 },
];

/**
 * What a click at the element's centre would land on is the element itself,
 * so nothing (the status bar, a squeezed neighbour) covers it.
 */
async function expectHitTestable(target: Locator): Promise<void> {
	const hit = await target.evaluate((el) => {
		const box = el.getBoundingClientRect();
		const top = document.elementFromPoint(
			box.left + box.width / 2,
			box.top + box.height / 2,
		);
		return top !== null && (top === el || el.contains(top));
	});
	expect(hit, String(target)).toBe(true);
}

/** A project with five files, open in a window where the file tree may be a drawer. */
async function openSeededWorkspace(page: Page, context: BrowserContext) {
	const student = await createStudent(context);
	const project = await createProject(student.workspaceId, { name: LONG_NAME });
	for (const name of ["a.md", "b.md", "c.md", "d.md", "e.md"])
		await seedFile(student.workspaceId, project.slug, name, `# ${name}\n`);
	await page.goto(workspacePath(student.workspaceId, project.id));
	await expect(workTabs(page)).toBeVisible({ timeout: 15_000 });
}

for (const viewport of SHORT) {
	test.describe(`the workspace at ${viewport.width} by ${viewport.height}`, () => {
		test.use({ viewport });

		test("each drawer fits the short window, and focused controls in it are not covered", async ({
			page,
			context,
		}) => {
			await openSeededWorkspace(page, context);
			await expectNoPageScrollSideways(page);
			// The work area takes the height between the header and the status bar.
			const work = await boxOf(page.getByRole("main", { name: "Work area" }));
			expect(work.height).toBeGreaterThan(viewport.height / 3);

			await openDrawer(page, "Projects");
			const newProject = page.getByRole("button", { name: "New project" });
			await tabTo(page, newProject);
			await expectHitTestable(newProject);
			await closeDrawer(page);

			await openDrawer(page, "Files");
			const row = page.getByTestId("file-row-c.md");
			await tabTo(page, page.getByTestId("file-row-a.md"), 40);
			await page.keyboard.press("ArrowDown");
			await page.keyboard.press("ArrowDown");
			await expect(row).toBeFocused();
			await expectHitTestable(row);
			await expectNoPageScrollSideways(page);
		});

		test("the short workspace has no automatic accessibility violations in either theme", async ({
			page,
			context,
		}) => {
			await openSeededWorkspace(page, context);
			for (const colorScheme of ["light", "dark"] as const) {
				await page.emulateMedia({ colorScheme });
				await expectNoViolations(page);
				await page.screenshot({
					path: `screenshots/short-workspace-${viewport.width}x${viewport.height}-${colorScheme}.png`,
				});
			}
		});
	});
}

test.describe("the workspace at 320 by 640", () => {
	test.use({ viewport: { width: 320, height: 640 } });

	test("the file tree shows several rows", async ({ page, context }) => {
		await openSeededWorkspace(page, context);
		await openDrawer(page, "Files");
		const body = await boxOf(page.getByTestId("file-tree-body"));
		const row = await boxOf(page.getByTestId("file-row-a.md"));
		expect(body.height).toBeGreaterThanOrEqual(4 * row.height);
		await page.screenshot({ path: "screenshots/short-workspace-320x640.png" });
	});
});

/** The admin tables that can be wider than a narrow box. */
const ADMIN_TABLES = [
	{
		path: "/admin/users",
		table: "admin-accounts",
		name: /^Accounts and their workspaces/,
	},
	{ path: "/admin/audit", table: "audit-table", name: /^Audit events/ },
	{ path: "/admin/logs?level=info", table: "logs-table", name: /^Log lines/ },
];

for (const viewport of SHORT) {
	test.describe(`the admin tables at ${viewport.width} by ${viewport.height}`, () => {
		test.use({ viewport });

		test("Tab reaches each table's box, and arrow keys scroll it to the last column", async ({
			page,
		}) => {
			test.setTimeout(90_000);
			// Signing in through the request context skips the Sign in click,
			// which can time out while a loaded dev server is still compiling.
			await apiLoginAs(page.request, "carol");
			for (const { path, table, name } of ADMIN_TABLES) {
				await expect(async () => {
					await page.goto(path);
					await expect(page.getByTestId(table).locator("tbody tr").first()).toBeVisible(
						{
							timeout: 2_000,
						},
					);
				}).toPass({ timeout: 20_000 });
				const region = page.getByRole("region", { name });
				await expect(region).toHaveCount(1);

				await fromTop(page);
				await tabTo(page, region, 120);
				await expect(region).toBeFocused();
				// The box shows the keyboard where it is.
				await expect(region).toHaveCSS("outline-style", "solid");
				const last = page.getByTestId(table).locator("thead th").last();
				const box = await boxOf(region);
				// Arrow keys scroll smoothly, and a live table can grow a column
				// after a press, so keep pressing until the box rests at its end.
				// The last header may be wider than the box, so its end must show.
				await expect(async () => {
					for (let step = 0; step < 20; step += 1)
						await page.keyboard.press("ArrowRight");
					await expect(region).toBeFocused();
					const atEnd = await region.evaluate(
						(el) => el.scrollLeft + el.clientWidth >= el.scrollWidth - 1,
					);
					expect(atEnd, table).toBe(true);
					const header = await boxOf(last);
					const end = header.x + header.width;
					expect(end, table).toBeLessThanOrEqual(box.x + box.width + 1);
					expect(end, table).toBeGreaterThan(box.x);
				}).toPass({ timeout: 20_000 });
				await expectNoPageScrollSideways(page);

				for (const colorScheme of ["light", "dark"] as const) {
					await page.emulateMedia({ colorScheme });
					await expectNoViolations(page);
				}
				await page.emulateMedia({ colorScheme: "light" });
			}
			await page.screenshot({
				path: `screenshots/short-admin-logs-${viewport.width}x${viewport.height}.png`,
			});
		});
	});
}

const ADMIN_TABS = [
	"users",
	"health",
	"logs",
	"audit",
	"agents",
	"network",
	"backups",
	"image",
	"certificate",
	"docker",
	"signin",
	"address",
	"settings",
	"shell",
];

/** Everything in the admin content fits its width, and a wide table scrolls in its own box. */
async function expectAdminContentFits(page: Page): Promise<void> {
	const overflow = await page.evaluate(() => {
		const main = document.querySelector("[data-testid=page-admin]") as HTMLElement;
		const right = main.getBoundingClientRect().left + main.clientWidth + 1;
		const spill = [...main.querySelectorAll("*")]
			.filter((el) => !el.closest(".pk-table-wrap"))
			.filter((el) => {
				const box = el.getBoundingClientRect();
				return box.width > 0 && box.right > right;
			})
			.map((el) => el.outerHTML.slice(0, 120));
		const clipped = [...main.querySelectorAll<HTMLElement>(".pk-table-wrap")]
			.filter((wrap) => wrap.scrollWidth > wrap.clientWidth + 1)
			.filter((wrap) => getComputedStyle(wrap).overflowX !== "auto")
			.map((wrap) => wrap.outerHTML.slice(0, 120));
		return { mainScrolls: main.scrollWidth > main.clientWidth, spill, clipped };
	});
	expect(overflow, page.url()).toEqual({ mainScrolls: false, spill: [], clipped: [] });
}

/**
 * A warning whose user has no account and that names a workspace, so the
 * table's last columns hold screen-reader-only full IDs. Those are positioned
 * absolutely, and must not widen the page from beyond the table's box.
 */
function logLineWithFullIds(): void {
	appendFileSync(
		E2E_JOURNAL_FILE,
		`${JSON.stringify({
			level: "warn",
			time: new Date().toISOString(),
			service: "api",
			route: "/narrow-layout/full-ids",
			status: 429,
			userId: "00000000-0000-4000-8000-000000000320",
			workspaceId: "00000000-0000-4000-8000-000000000375",
			code: "RATE_LIMITED",
			msg: "request",
		})}\n`,
	);
}

// 320 px is the WCAG 1.4.10 reflow width; 375 px is a common phone.
for (const width of [NARROW.width, 375, 320]) {
	test.describe(`the admin area at ${width} px`, () => {
		test.use({ viewport: { width, height: NARROW.height } });

		test("no tab scrolls sideways, and a wide table scrolls in its own box", async ({
			page,
		}) => {
			test.setTimeout(120_000);
			logLineWithFullIds();
			await apiLoginAs(page.request, "carol");
			for (const tab of ADMIN_TABS) {
				await page.goto(`/admin/${tab}`);
				await expect(page.getByTestId(`admin-tab-${tab}`)).toHaveAttribute(
					"aria-current",
					"page",
					{ timeout: 15_000 },
				);
				await expect(page.getByRole("heading", { level: 2 }).first()).toBeVisible();
				await expect(
					page.getByTestId("page-admin").locator("[aria-busy=true]"),
				).toHaveCount(0);
				await expectNoPageScrollSideways(page);
				await expectAdminContentFits(page);
				if (width === 320 && ["users", "address", "docker"].includes(tab)) {
					await page.screenshot({
						path: `screenshots/narrow-admin-${tab}-320.png`,
						fullPage: true,
					});
				}
			}
		});
	});
}

test.describe("the admin area at 560 px", () => {
	test.use({ viewport: NARROW });

	test("Tab reaches every admin tab and a Users row's last-column action on screen", async ({
		page,
	}) => {
		await loginAs(page, "carol");
		await page.goto("/admin/users");
		const table = page.getByTestId("admin-accounts");
		await expect(table).toBeVisible({ timeout: 15_000 });

		await fromTop(page);
		for (const tab of ADMIN_TABS)
			await tabTo(page, page.getByTestId(`admin-tab-${tab}`));

		// The first row's last-column action (a menu, or Revoke… on an invitation),
		// the one a narrow table would clip. Your own row has none.
		const action = table.locator("tbody td:last-child button").first();
		// Tabbing on from the strip, as a keyboard user does, scrolls the table's box.
		await tabTo(page, action, 120);
		const box = await boxOf(action);
		const wrap = await boxOf(page.locator(".pk-table-wrap", { has: table }).first());
		expect(box.x).toBeGreaterThanOrEqual(wrap.x);
		expect(box.x + box.width).toBeLessThanOrEqual(wrap.x + wrap.width + 1);
		await page.keyboard.press("Enter");
		await expect(
			page.getByRole("menu").or(page.getByRole("alertdialog")),
		).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(action).toBeFocused();
		await expectNoPageScrollSideways(page);
	});

	for (const colorScheme of ["light", "dark"] as const) {
		test(`every admin tab has no automatic accessibility violations (${colorScheme})`, async ({
			page,
		}) => {
			test.setTimeout(180_000);
			await page.emulateMedia({ colorScheme });
			await loginAs(page, "carol");
			for (const tab of ADMIN_TABS) {
				await page.goto(`/admin/${tab}`);
				await expect(page.getByTestId(`admin-tab-${tab}`)).toHaveAttribute(
					"aria-current",
					"page",
					{ timeout: 15_000 },
				);
				await expect(
					page.getByTestId("page-admin").locator("[aria-busy=true]"),
				).toHaveCount(0);
				await expectNoViolations(page);
				if (tab === "users" || tab === "logs" || tab === "settings") {
					await page.screenshot({
						path: `screenshots/narrow-admin-${tab}-${colorScheme}.png`,
					});
				}
			}
		});
	}
});

/**
 * The touch-action values between `target` and the root that stop a pinch.
 * The browser intersects them, so one blocking ancestor blocks pinch-zoom
 * anywhere inside it (WCAG 1.4.4).
 */
async function pinchBlockers(target: Locator): Promise<string[]> {
	return target.evaluate((el) => {
		const blockers: string[] = [];
		for (let node: Element | null = el; node; node = node.parentElement) {
			const value = getComputedStyle(node).touchAction;
			if (value === "auto" || value === "manipulation" || value.includes("pinch-zoom"))
				continue;
			blockers.push(
				`${node.tagName.toLowerCase()}#${node.id}.${node.className}: ${value}`,
			);
		}
		return blockers;
	});
}

test.describe("the workspace on a touch screen", () => {
	test.use({ hasTouch: true });

	for (const viewport of [NARROW, { width: 1280, height: 800 }]) {
		test(`pinch-zoom is allowed inside every pane at ${viewport.width} px`, async ({
			page,
			context,
		}) => {
			await page.setViewportSize(viewport);
			await openSeededWorkspace(page, context);
			// Measured where each is seen: in its drawer at 560 px.
			const narrow = viewport.width < 896;
			if (narrow) await openDrawer(page, "Projects");
			const newProject = page.getByRole("button", { name: "New project" });
			expect(await pinchBlockers(newProject)).toEqual([]);
			if (narrow) await closeDrawer(page);
			const empty = page.getByTestId("empty-open-terminal");
			expect(await pinchBlockers(empty)).toEqual([]);
			if (narrow) await openDrawer(page, "Files");
			const row = page.getByTestId("file-row-a.md");
			await expect(row).toBeVisible();
			expect(await pinchBlockers(row)).toEqual([]);
			if (narrow) await closeDrawer(page);
			// A mounted terminal, where xterm.js sets its own touch handling.
			await page.getByTestId("empty-open-terminal").click();
			const screen = page.locator(".xterm-screen");
			await expect(screen).toBeVisible({ timeout: 15_000 });
			expect(await pinchBlockers(screen)).toEqual([]);
		});
	}

	test("a one-finger drag on a pane handle still resizes the pane", async ({
		page,
		context,
	}) => {
		await page.setViewportSize({ width: 1280, height: 800 });
		await openSeededWorkspace(page, context);
		const files = page.locator(".pk-right-pane");
		const before = (await boxOf(files)).width;
		const grip = await boxOf(page.getByRole("separator", { name: "Resize file tree" }));
		const x = grip.x + grip.width / 2;
		const y = grip.y + grip.height / 2;
		// Playwright has no touch drag; the DevTools protocol sends real touch events.
		const cdp = await context.newCDPSession(page);
		await cdp.send("Input.dispatchTouchEvent", {
			type: "touchStart",
			touchPoints: [{ x, y }],
		});
		for (let step = 1; step <= 8; step += 1)
			await cdp.send("Input.dispatchTouchEvent", {
				type: "touchMove",
				touchPoints: [{ x: x - step * 10, y }],
			});
		await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
		await expect
			.poll(async () => Math.round((await boxOf(files)).width))
			.toBe(Math.round(before + 80));
	});
});
