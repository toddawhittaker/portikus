/**
 * The admin and instructor screens' finishing details (SPEC.md sections 20.1,
 * 25.6 and 25.8): the Class now card and its key, the rail and the Settings
 * index kept in view, one attention count, the log level chips' on and off
 * looks, readable disabled buttons, the phone layout and its 44 px targets,
 * and a readable line length for help and descriptions.
 */
import { type Browser, expect, type Locator, type Page, test } from "@playwright/test";
import { backupSet, hostStatus } from "./backup-channel";
import { join, newCourse } from "./course-profile-helpers";
import {
	contrast,
	createProject,
	createSignedInUser,
	createStudent,
	expectNoViolations,
	loginAs,
	query,
	routeApi,
	studentIn,
	workspacePath,
} from "./helpers";

const SCHEMES = ["dark", "light"] as const;
const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1440, height: 900 };
/** The phone target size this product sets (DESIGN.md, "Space, density and layout"). */
const TOUCH = 44;

type Box = { x: number; y: number; width: number; height: number };

async function boxOf(locator: Locator): Promise<Box> {
	const box = await locator.boundingBox();
	if (!box) throw new Error("the element has no box");
	return box;
}

/** A button's fill, edge, opacity and label colour, and the fill its label shows through. */
async function buttonLooks(button: Locator) {
	return button.evaluate((element) => {
		let ground = "rgb(255, 255, 255)";
		for (let at = element.parentElement; at; at = at.parentElement) {
			const colour = getComputedStyle(at).backgroundColor;
			if (colour !== "rgba(0, 0, 0, 0)" && colour !== "transparent") {
				ground = colour;
				break;
			}
		}
		const style = getComputedStyle(element);
		return {
			background: style.backgroundColor,
			borderStyle: style.borderTopStyle,
			borderColor: style.borderTopColor,
			opacity: style.opacity,
			color: style.color,
			ground,
		};
	});
}

function overlaps(a: Box, b: Box): boolean {
	return (
		a.x < b.x + b.width &&
		b.x < a.x + a.width &&
		a.y < b.y + b.height &&
		b.y < a.y + a.height
	);
}

async function asAdmin(page: Page, path: string): Promise<void> {
	await loginAs(page, "carol");
	await page.goto(path);
}

/** A course with an instructor signed in on this page and `students` running students. */
async function courseAsInstructor(
	page: Page,
	browser: Browser,
	students: number,
): Promise<{ courseId: string; studentIds: string[]; names: string[] }> {
	const course = await newCourse(
		"agentic",
		`Polish ${crypto.randomUUID().slice(0, 6)}`,
	);
	const { userId } = await createSignedInUser(page.context(), "student");
	await query("update users set display_name = 'Dr. Ivy Okafor' where id = $1", [
		userId,
	]);
	await join(course.id, userId, "instructor");
	const studentIds: string[] = [];
	const names: string[] = [];
	for (let made = 0; made < students; made += 1) {
		const student = await studentIn(browser, `Student ${made}`);
		await join(course.id, student.userId, "student");
		studentIds.push(student.userId);
		names.push(student.name);
	}
	return { courseId: course.id, studentIds, names };
}

/** One student waiting in live help, so the queue shows a tile with Join. */
async function oneWaiting(page: Page, userId: string): Promise<void> {
	const now = Date.now();
	await routeApi(page, "**/courses/*/live-help", (route) =>
		route.fulfill({
			json: {
				sessions: [
					{
						id: "5e551011-0000-4000-8000-000000000001",
						projectId: "5e551011-0000-4000-8000-000000000002",
						projectName: "Weather Now",
						userId,
						displayName: "Waiting student",
						typing: false,
						startedAt: new Date(now - 6 * 60_000).toISOString(),
						endsAt: new Date(now + 54 * 60_000).toISOString(),
						workspaceState: "running",
					},
				],
			},
		}),
	);
}

/**
 * Every control in `root` drawn smaller than a thumb, as "name: width x
 * height". A link inside running text is exempt (WCAG 2.5.8). A target's
 * invisible ring (a ::after drawn outside it) counts as part of it, and a
 * box inside its own label counts the label.
 */
async function smallTargets(root: Locator): Promise<string[]> {
	return root.evaluate((element, least) => {
		const found: string[] = [];
		const controls = element.querySelectorAll<HTMLElement>(
			"a[href], button, input:not([type='hidden']), select, summary, [role='button']",
		);
		for (const control of controls) {
			const style = getComputedStyle(control);
			if (style.visibility === "hidden" || control.getClientRects().length === 0)
				continue;
			if (control.closest("[aria-hidden='true'], [inert], .sr-only")) continue;
			// A link in a sentence sizes with the text around it.
			if (
				control.tagName === "A" &&
				control.closest("p, li") &&
				style.display === "inline"
			)
				continue;
			let target: HTMLElement = control;
			if (control.tagName === "INPUT") {
				const label = control.closest("label");
				if (label) target = label;
			}
			const box = target.getBoundingClientRect();
			// A box drawn 1 px square is the hidden input of a chip or a switch; its label is the target.
			if (box.width <= 1 && box.height <= 1) continue;
			let { width, height } = box;
			const ring = getComputedStyle(target, "::after");
			if (ring.content !== "none" && ring.position === "absolute") {
				width = Math.max(width, box.width - 2 * Number.parseFloat(ring.left || "0"));
				height = Math.max(height, box.height - 2 * Number.parseFloat(ring.top || "0"));
			}
			if (width + 0.5 < least || height + 0.5 < least) {
				const name =
					control.getAttribute("aria-label") ??
					(control.textContent?.trim().slice(0, 40) ||
						control.id ||
						control.getAttribute("type") ||
						control.tagName);
				found.push(
					`${control.tagName.toLowerCase()} "${name}": ${Math.round(width)} x ${Math.round(height)}`,
				);
			}
		}
		return found;
	}, TOUCH);
}

test.describe("the Course page's Class now card", () => {
	for (const colorScheme of SCHEMES) {
		test(`hugs its content and keys its dots (${colorScheme})`, async ({
			page,
			browser,
		}) => {
			await page.emulateMedia({ colorScheme });
			await page.setViewportSize(DESKTOP);
			const { courseId, studentIds } = await courseAsInstructor(page, browser, 3);
			await query("update workspaces set state = 'stopped' where owner_user_id = $1", [
				studentIds[2],
			]);
			await oneWaiting(page, studentIds[0] as string);
			await page.goto(`/course/${courseId}`);
			const card = page.getByTestId("course-counts");
			await expect(card).toBeVisible();
			const key = card.getByTestId("class-dots-key");
			await expect(key.locator("li")).toHaveText([
				"Waiting for help",
				"Running",
				"Stopped",
			]);
			// The key explains dots that are decorative; the sentence carries the counts.
			await expect(key).toHaveAttribute("aria-hidden", "true");
			await expect(card).toContainText("3 students");

			// The card ends where its content does, not at the live help card's foot.
			const room = await card.evaluate((element) => {
				const last = element.lastElementChild as HTMLElement;
				const padding = Number.parseFloat(getComputedStyle(element).paddingBlockEnd);
				return (
					element.getBoundingClientRect().bottom -
					last.getBoundingClientRect().bottom -
					padding
				);
			});
			expect(room).toBeLessThanOrEqual(2);
			await expectNoViolations(page);
		});
	}
});

test.describe("the admin rail and the Settings index", () => {
	test("stay in view while a long page scrolls (desktop)", async ({ page }) => {
		await page.setViewportSize(DESKTOP);
		await asAdmin(page, "/admin/settings");
		await expect(
			page.getByRole("heading", { name: "Settings", level: 2 }),
		).toBeVisible();
		const rail = page.getByRole("navigation", { name: "Administration" });
		const index = page.getByRole("navigation", { name: "Settings sections" });
		const railBefore = await boxOf(rail);
		const indexBefore = await boxOf(index);
		const scroller = page.getByTestId("page-admin");
		const scrolled = await scroller.evaluate((main) => {
			main.scrollTop = main.scrollHeight;
			return main.scrollTop;
		});
		expect(scrolled).toBeGreaterThan(400);
		await expect
			.poll(async () => (await boxOf(rail)).y, { message: "the rail stays put" })
			.toBe(railBefore.y);
		const indexAfter = await boxOf(index);
		// The index sticks near the top of the scrolling pane, wholly in the window.
		expect(indexAfter.y).toBeGreaterThanOrEqual(railBefore.y);
		expect(indexAfter.y).toBeLessThanOrEqual(indexBefore.y);
		expect(indexAfter.y + indexAfter.height).toBeLessThanOrEqual(DESKTOP.height);
		await expect(index.getByRole("link").first()).toBeInViewport();
		// And it marks the section in view, here the last one.
		await expect(index.getByRole("link", { name: "Email and alerts" })).toHaveAttribute(
			"aria-current",
			"location",
		);
		await expect(index.locator('[aria-current="location"]')).toHaveCount(1);
	});

	test("the rail stays in view in a short window, where the whole page scrolls", async ({
		page,
	}) => {
		// A phone held sideways: wide enough for the rail, too short for a framed pane.
		await page.setViewportSize({ width: 844, height: 390 });
		await asAdmin(page, "/admin/settings");
		await expect(
			page.getByRole("heading", { name: "Settings", level: 2 }),
		).toBeVisible();
		const rail = page.getByRole("navigation", { name: "Administration" });
		const scrolled = await page.evaluate(() => {
			const root = document.querySelector<HTMLElement>(".pk-root");
			if (!root) return 0;
			root.scrollTop = root.scrollHeight;
			return root.scrollTop;
		});
		expect(scrolled).toBeGreaterThan(400);
		await expect(rail.getByRole("link", { name: "Users" })).toBeInViewport();
	});

	test("stay in reach on a phone: the section control and the index chips", async ({
		page,
	}) => {
		await page.setViewportSize(PHONE);
		await asAdmin(page, "/admin/settings");
		await expect(
			page.getByRole("heading", { name: "Settings", level: 2 }),
		).toBeAttached();
		const toggle = page.getByRole("button", { name: /^Section: Settings/ });
		const index = page.getByRole("navigation", { name: "Settings sections" });
		await page.getByTestId("page-admin").evaluate((main) => {
			main.scrollTop = main.scrollHeight;
		});
		await expect(toggle).toBeInViewport();
		await expect(index).toBeInViewport();
		expect(overlaps(await boxOf(toggle), await boxOf(index))).toBe(false);
	});
});

test.describe("one attention count", () => {
	// Cleared after the test, so no other spec's Health mark counts this workspace.
	let throttled: string | null = null;
	test.afterEach(async () => {
		if (throttled)
			await query("update workspaces set cpu_throttle = null where id = $1", [
				throttled,
			]);
	});

	test("the Health mark, the status bar and the Needs attention list agree, on Health and off it", async ({
		page,
		browser,
	}) => {
		const student = await studentIn(browser, "Throttled");
		throttled = student.workspaceId;
		await query("update workspaces set cpu_throttle = $2 where id = $1", [
			student.workspaceId,
			JSON.stringify({
				at: new Date(Date.now() - 12 * 60_000).toISOString(),
				averagePercent: 96,
				thresholdPercent: 80,
				windowMinutes: 30,
				sharePercent: 25,
				allowance: "25ms/100ms",
			}),
		]);
		await page.setViewportSize(DESKTOP);
		await asAdmin(page, "/admin/health");
		await expect(page.getByTestId("health-verdict")).toBeVisible({ timeout: 15_000 });

		const read = () =>
			page.evaluate(() => {
				const text = (id: string) =>
					document.querySelector(`[data-testid="${id}"]`)?.textContent ?? "";
				const verdict = document.querySelector('[data-testid="health-verdict"]');
				const rows =
					(verdict?.querySelectorAll("tbody tr").length ?? 0) +
					(verdict?.querySelectorAll("li").length ?? 0);
				return {
					mark: Number.parseInt(text("admin-health-mark"), 10),
					pill: Number.parseInt(text("admin-attention-pill"), 10),
					heading: Number.parseInt(text("health-attention-count"), 10),
					rows,
				};
			});
		await expect.poll(async () => (await read()).rows).toBeGreaterThanOrEqual(1);
		const onHealth = await read();
		expect(onHealth.mark).toBeGreaterThanOrEqual(1);
		expect(onHealth).toEqual({
			mark: onHealth.rows,
			pill: onHealth.rows,
			heading: onHealth.rows,
			rows: onHealth.rows,
		});
		// The throttled workspace is one of the rows.
		await expect(page.getByTestId("health-guard")).toContainText("Throttled");

		// Off the Health tab the rail mark and the status bar still say the same.
		await page.getByTestId("admin-tab-backups").click();
		await expect(
			page.getByRole("heading", { name: "Backups", level: 2 }),
		).toBeVisible();
		const offHealth = await read();
		expect(offHealth.mark).toBe(offHealth.pill);
	});
});

test.describe("the Logs level chips", () => {
	for (const colorScheme of SCHEMES) {
		test(`have one off look and one on look, the level's colour only in its dot (${colorScheme})`, async ({
			page,
		}) => {
			await page.emulateMedia({ colorScheme });
			await page.setViewportSize(DESKTOP);
			await asAdmin(page, "/admin/logs");
			const levels = page.getByRole("group", { name: "Levels" });
			await expect(levels).toBeVisible({ timeout: 15_000 });
			const chip = (name: string) => levels.locator("label", { hasText: name });
			const look = (name: string) =>
				chip(name).evaluate((label) => {
					const style = getComputedStyle(label);
					const tick = label.querySelector(".pk-chipcheck-tick");
					const dot = label.querySelector(".pk-chipcheck-dot");
					return {
						background: style.backgroundColor,
						border: style.borderColor,
						tick: tick ? getComputedStyle(tick).display !== "none" : false,
						dot: dot ? getComputedStyle(dot).backgroundColor : null,
					};
				});

			const error = levels.getByRole("checkbox", { name: "Error" });
			const info = levels.getByRole("checkbox", { name: "Info" });
			// The starting filter shows errors and warnings.
			await expect(error).toBeChecked();
			await expect(info).not.toBeChecked();
			const errorOn = await look("Error");
			const warnOn = await look("Warn");
			const infoOff = await look("Info");
			const debugOff = await look("Debug");
			expect(errorOn.tick).toBe(true);
			expect(infoOff.tick).toBe(false);
			// Every on chip looks alike, every off chip looks alike, and the two differ.
			expect(warnOn.background).toBe(errorOn.background);
			expect(warnOn.border).toBe(errorOn.border);
			expect(debugOff.background).toBe(infoOff.background);
			expect(debugOff.border).toBe(infoOff.border);
			expect(infoOff.background).not.toBe(errorOn.background);
			expect(infoOff.border).not.toBe(errorOn.border);
			// The level's colour is the dot's alone, and stays when the chip turns off.
			expect(errorOn.dot).not.toBe(warnOn.dot);
			await chip("Error").click();
			await expect(error).not.toBeChecked();
			// Away from the hover look, and past the colour's short transition.
			await page.mouse.move(0, 0);
			await expect
				.poll(async () => (await look("Error")).background)
				.toBe(infoOff.background);
			const errorOff = await look("Error");
			expect(errorOff.tick).toBe(false);
			expect(errorOff.background).toBe(infoOff.background);
			expect(errorOff.border).toBe(infoOff.border);
			expect(errorOff.dot).toBe(errorOn.dot);
			await chip("Info").click();
			await expect(info).toBeChecked();
			await page.mouse.move(0, 0);
			await expect
				.poll(async () => (await look("Info")).background)
				.toBe(errorOn.background);
			const infoOn = await look("Info");
			expect(infoOn.tick).toBe(true);
			expect(infoOn.background).toBe(errorOn.background);
			// Space on the focused box turns it back on, as any checkbox does.
			await error.focus();
			await page.keyboard.press("Space");
			await expect(error).toBeChecked();
			expect((await look("Error")).tick).toBe(true);
			await expectNoViolations(page);
		});
	}
});

test.describe("a disabled button", () => {
	for (const colorScheme of SCHEMES) {
		test(`reads as disabled and stays readable (${colorScheme})`, async ({ page }) => {
			await page.emulateMedia({ colorScheme });
			await page.setViewportSize(DESKTOP);
			await asAdmin(page, "/admin/settings");
			const save = page.getByRole("button", { name: "Save stop times" });
			await expect(save).toBeDisabled({ timeout: 15_000 });
			// An enabled secondary button on the same page, for comparison.
			const enabled = page.getByRole("button", { name: "Restore built-in text…" });
			await expect(enabled).toBeEnabled();
			const looks = await buttonLooks(save);
			const enabledLooks = await buttonLooks(enabled);
			// Faded, not broken: no fill and a solid edge, at full opacity.
			expect(looks.background).toBe("rgba(0, 0, 0, 0)");
			expect(looks.borderStyle).toBe("solid");
			expect(looks.opacity).toBe("1");
			// The label meets text contrast against what shows through it.
			expect(contrast(looks.color, looks.ground)).toBeGreaterThanOrEqual(4.5);
			// And it differs from an enabled button in fill, edge and ink.
			expect(looks.background).not.toBe(enabledLooks.background);
			expect(looks.borderColor).not.toBe(enabledLooks.borderColor);
			expect(looks.color).not.toBe(enabledLooks.color);
		});
	}
});

test.describe("on a phone", () => {
	test.beforeEach(async ({ page }) => {
		await page.setViewportSize(PHONE);
	});

	test("the Health range sits clear of the Trends heading", async ({ page }) => {
		await asAdmin(page, "/admin/health");
		const heading = page.getByRole("heading", { name: "Trends" });
		const range = page.getByRole("group", { name: "Time range" });
		await expect(range).toBeVisible({ timeout: 15_000 });
		expect(overlaps(await boxOf(heading), await boxOf(range))).toBe(false);
		const card = await boxOf(page.getByTestId("health-trends"));
		const rangeBox = await boxOf(range);
		expect(rangeBox.x).toBeGreaterThanOrEqual(card.x);
		expect(rangeBox.x + rangeBox.width).toBeLessThanOrEqual(card.x + card.width + 0.5);
		for (const button of await range.getByRole("button").all()) {
			expect((await boxOf(button)).height).toBeGreaterThanOrEqual(TOUCH);
		}
	});

	test("the Backups Clean up heading keeps to one line and its targets take a thumb", async ({
		page,
		browser,
	}) => {
		const student = await studentIn(browser, "Backed up");
		const [row] = await query<{ incus_instance_name: string }>(
			"select incus_instance_name from workspaces where id = $1",
			[student.workspaceId],
		);
		const instance = row?.incus_instance_name as string;
		await routeApi(page, "**/admin/backups", (route) =>
			route.fulfill({
				json: {
					host: hostStatus({
						sets: [
							backupSet("20261112T073000Z", [instance]),
							backupSet("20261111T073000Z", [instance]),
						],
					}),
					hostReportedAt: new Date().toISOString(),
					hostStale: false,
					vm: { snapshots: [], keptHomes: [] },
					vmListedAt: new Date().toISOString(),
					requests: [],
					workspaces: [],
				},
			}),
		);
		await asAdmin(page, "/admin/backups");
		const heading = page.getByRole("heading", { name: "Clean up" });
		await expect(heading).toBeVisible({ timeout: 15_000 });
		const lineHeight = await heading.evaluate((h) =>
			Number.parseFloat(getComputedStyle(h).lineHeight),
		);
		expect((await boxOf(heading)).height).toBeLessThanOrEqual(lineHeight + 1);
		// The count goes under the heading, not beside it squeezing it.
		const count = await boxOf(page.getByTestId("backups-cleanup-count"));
		expect(count.y).toBeGreaterThanOrEqual((await boxOf(heading)).y);
		expect(await smallTargets(page.getByTestId("admin-content"))).toEqual([]);
	});

	for (const [tab, ready] of [
		["settings", "Settings"],
		["health", "Health"],
		["network", "Network"],
		["logs", "Logs"],
		["audit", "Audit"],
	] as const) {
		test(`${ready} targets take a thumb`, async ({ page }) => {
			await asAdmin(page, `/admin/${tab}`);
			await expect(page.getByRole("heading", { name: ready, level: 2 })).toBeAttached({
				timeout: 15_000,
			});
			await page.waitForTimeout(1000);
			expect(await smallTargets(page.locator("main"))).toEqual([]);
		});
	}

	test("the Settings section chips take a thumb", async ({ page }) => {
		await asAdmin(page, "/admin/settings");
		const index = page.getByRole("navigation", { name: "Settings sections" });
		await expect(index).toBeVisible({ timeout: 15_000 });
		for (const link of await index.getByRole("link").all()) {
			expect((await boxOf(link)).height).toBeGreaterThanOrEqual(TOUCH);
		}
	});

	test("the live help targets take a thumb", async ({ page, browser }) => {
		const { courseId, studentIds } = await courseAsInstructor(page, browser, 1);
		await oneWaiting(page, studentIds[0] as string);
		await page.goto(`/course/${courseId}/live`);
		await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
		await page.waitForTimeout(1000);
		expect(await smallTargets(page.locator("main"))).toEqual([]);
	});

	test("Users targets take a thumb", async ({ page, browser }) => {
		await studentIn(browser, "Thumb");
		await asAdmin(page, "/admin");
		await expect(page.getByTestId("admin-accounts")).toBeVisible({ timeout: 15_000 });
		expect(await smallTargets(page.getByTestId("admin-content"))).toEqual([]);
	});

	for (const colorScheme of SCHEMES) {
		test(`course member cards are compact, the menu beside the name, and every target takes a thumb (${colorScheme})`, async ({
			page,
			browser,
		}) => {
			await page.emulateMedia({ colorScheme });
			const { courseId, studentIds, names } = await courseAsInstructor(
				page,
				browser,
				2,
			);
			await oneWaiting(page, studentIds[0] as string);
			await page.goto(`/course/${courseId}`);
			const table = page.getByTestId("course-members");
			await expect(table).toBeVisible();
			const card = table.locator("tbody tr").filter({ hasText: names[1] as string });
			const name = card.getByRole("rowheader");
			const menu = card.getByRole("button", { name: /^Actions for / });
			const nameBox = await boxOf(name);
			const menuBox = await boxOf(menu);
			// The menu shares the name's row, at the card's end.
			expect(menuBox.y).toBeLessThan(nameBox.y + nameBox.height);
			expect(menuBox.x).toBeGreaterThan(nameBox.x + nameBox.width - 1);
			// Name, role and launch, then the workspace: no row left for a lone menu.
			const cardBox = await boxOf(card);
			expect(cardBox.height).toBeLessThan(130);
			expect(await smallTargets(page.locator("main"))).toEqual([]);
			await expectNoViolations(page);
		});
	}
});

test.describe("help and descriptions", () => {
	/** The most characters any line of the element's text holds. */
	async function longestLine(locator: Locator): Promise<number> {
		return locator.evaluate((element) => {
			const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
			const lines = new Map<number, number>();
			const range = document.createRange();
			for (let node = walker.nextNode(); node; node = walker.nextNode()) {
				const text = node.textContent ?? "";
				for (let at = 0; at < text.length; at += 1) {
					range.setStart(node, at);
					range.setEnd(node, at + 1);
					const rect = range.getBoundingClientRect();
					if (rect.width === 0 && rect.height === 0) continue;
					const line = Math.round(rect.top);
					lines.set(line, (lines.get(line) ?? 0) + 1);
				}
			}
			return Math.max(0, ...lines.values());
		});
	}

	test("the administrator help keeps lines near 65 to 70 characters", async ({
		page,
	}) => {
		await page.setViewportSize(DESKTOP);
		await asAdmin(page, "/admin/help");
		const paragraphs = page.locator(".pk-help-article p");
		await expect(paragraphs.first()).toBeVisible({ timeout: 15_000 });
		for (const index of [0, 1, 2, 3]) {
			expect(await longestLine(paragraphs.nth(index))).toBeLessThanOrEqual(72);
		}
	});

	test("a long field hint and a card description keep a readable line", async ({
		page,
	}) => {
		await page.setViewportSize(DESKTOP);
		await asAdmin(page, "/admin/backups");
		const description = page
			.getByTestId("backups-key-group")
			.getByText(/^The key that unlocks every backup/);
		await expect(description).toBeVisible({ timeout: 15_000 });
		expect(await longestLine(description)).toBeLessThanOrEqual(72);
		const width = await description.evaluate((p) => getComputedStyle(p).maxInlineSize);
		expect(width).toMatch(/px$/);
	});
});

test.describe("student screens", () => {
	for (const colorScheme of SCHEMES) {
		test(`a disabled primary button reads as disabled, not as a dim enabled one (${colorScheme})`, async ({
			page,
			context,
		}) => {
			await page.emulateMedia({ colorScheme });
			const student = await createStudent(context);
			await page.goto(workspacePath(student.workspaceId));
			await page.getByTestId("new-project").click();
			await page.getByRole("menuitem", { name: "New project" }).click();
			const dialog = page.getByTestId("dialog-create-project");
			const create = dialog.getByRole("button", { name: "Create project" });
			// Nothing named yet, so Create cannot act.
			await expect(create).toBeDisabled();
			const looks = await buttonLooks(create);
			expect(looks).toMatchObject({
				background: "rgba(0, 0, 0, 0)",
				borderStyle: "solid",
				opacity: "1",
			});
			expect(contrast(looks.color, looks.ground)).toBeGreaterThanOrEqual(4.5);
			// Once there is a name it is the accent fill again, with its own ink.
			await page.getByTestId("field-name").fill("Weather");
			await expect(create).toBeEnabled();
			await expect
				.poll(async () => (await buttonLooks(create)).background)
				.not.toBe("rgba(0, 0, 0, 0)");
			expect((await buttonLooks(create)).color).not.toBe(looks.color);
		});

		test(`a selected project's icon takes the accent text colour (${colorScheme})`, async ({
			page,
			context,
		}) => {
			await page.emulateMedia({ colorScheme });
			const student = await createStudent(context);
			const project = await createProject(student.workspaceId, { name: "Weather" });
			await page.goto(workspacePath(student.workspaceId, project.id));
			const current = page.locator('.pk-list-row[aria-current="page"]').first();
			await expect(current).toBeVisible({ timeout: 15_000 });
			const colours = await current.evaluate((row) => {
				const probe = document.createElement("span");
				probe.style.color = "var(--accent-text)";
				row.append(probe);
				const accentText = getComputedStyle(probe).color;
				probe.remove();
				const icon = row.querySelector(".pk-icon");
				return { icon: icon ? getComputedStyle(icon).color : "", accentText };
			});
			expect(colours.icon).toBe(colours.accentText);
		});
	}
});
