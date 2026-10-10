/**
 * Every drag in the work area has a click alternative (WCAG 2.5.7, SPEC.md
 * §25.8): a tab moves from its right-click menu, a pane joins another tab
 * from its actions menu, and split sizes reset from the same menu. These
 * tests use the pointer only and never drag.
 */
import { expect, type Locator, type Page, test } from "@playwright/test";
import {
	createProject,
	createStudent,
	expectConnected,
	expectNoViolations,
	newTerminal,
	query,
	seedFile,
	terminalIds,
	workspacePath,
	workTabs,
} from "./helpers";

function tabs(page: Page): Locator {
	return workTabs(page).getByRole("tab");
}

async function tabOrder(page: Page): Promise<string[]> {
	return tabs(page).evaluateAll((nodes) =>
		nodes.map((node) => node.getAttribute("data-testid") ?? ""),
	);
}

/** The open menus, scanned and photographed in both themes. */
async function scanInBothThemes(page: Page, shot: string): Promise<void> {
	for (const colorScheme of ["light", "dark"] as const) {
		await page.emulateMedia({ colorScheme });
		await expectNoViolations(page, '[role="menu"]');
		const width = page.viewportSize()?.width ?? 0;
		await page.screenshot({ path: `screenshots/${shot}-${colorScheme}-${width}.png` });
	}
}

/** Open a terminal tab and wait for it to connect; returns the new terminal's id. */
async function openTerminal(
	page: Page,
	workspaceId: string,
	projectId: string,
	count: number,
): Promise<string> {
	const before = await terminalIds(workspaceId, projectId);
	await newTerminal(page);
	await expect
		.poll(async () => (await terminalIds(workspaceId, projectId)).length)
		.toBe(count);
	const id = (await terminalIds(workspaceId, projectId)).find(
		(candidate) => !before.includes(candidate),
	);
	if (!id) throw new Error("the terminal row was not created");
	await expectConnected(page, id);
	return id;
}

async function paneMenu(page: Page, terminalId: string): Promise<Locator> {
	await page.getByTestId(`terminal-actions-${terminalId}`).click();
	const menu = page.getByRole("menu", { name: /^Actions for / });
	await expect(menu).toBeVisible();
	return menu;
}

test("a tab moves left and right from its right-click menu", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	const project = await createProject(student.workspaceId, { name: "Tab menu" });
	const paths = ["one.txt", "two.txt", "three.txt"];
	for (const path of paths) {
		await seedFile(student.workspaceId, project.slug, path, `${path}\n`);
	}
	await query("update projects set layout = $2 where id = $1", [
		project.id,
		JSON.stringify({
			tabs: paths.map((path) => ({ id: `file:${path}`, root: { type: "file", path } })),
		}),
	]);
	await page.goto(workspacePath(student.workspaceId, project.id));
	await expect(tabs(page)).toHaveCount(3, { timeout: 15_000 });

	await page.getByTestId("tab-file:two.txt").click({ button: "right" });
	const menu = page.getByRole("menu", { name: "Actions for two.txt" });
	await expect(menu).toBeVisible();
	await scanInBothThemes(page, "tab-menu");
	await menu.getByRole("menuitem", { name: "Move left" }).click();
	await expect
		.poll(() => tabOrder(page))
		.toEqual(["tab-file:two.txt", "tab-file:one.txt", "tab-file:three.txt"]);

	// At the start of the strip there is no further left to go.
	await page.getByTestId("tab-file:two.txt").click({ button: "right" });
	await expect(menu.getByRole("menuitem", { name: "Move left" })).toHaveAttribute(
		"aria-disabled",
		"true",
	);
	await menu.getByRole("menuitem", { name: "Move right" }).click();
	await expect
		.poll(() => tabOrder(page))
		.toEqual(["tab-file:one.txt", "tab-file:two.txt", "tab-file:three.txt"]);

	// At the end there is no further right.
	await page.getByTestId("tab-file:three.txt").click({ button: "right" });
	const last = page.getByRole("menu", { name: "Actions for three.txt" });
	await expect(last.getByRole("menuitem", { name: "Move right" })).toHaveAttribute(
		"aria-disabled",
		"true",
	);
});

test("closing a tab from its menu or with Delete keeps focus on the selected tab", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	const project = await createProject(student.workspaceId, { name: "Tab close focus" });
	const paths = ["one.txt", "two.txt", "three.txt"];
	for (const path of paths) {
		await seedFile(student.workspaceId, project.slug, path, `${path}\n`);
	}
	await query("update projects set layout = $2 where id = $1", [
		project.id,
		JSON.stringify({
			tabs: paths.map((path) => ({ id: `file:${path}`, root: { type: "file", path } })),
		}),
	]);
	await page.goto(workspacePath(student.workspaceId, project.id));
	await expect(tabs(page)).toHaveCount(3, { timeout: 15_000 });
	const selected = workTabs(page).getByRole("tab", { selected: true });

	await page.getByTestId("tab-file:two.txt").click({ button: "right" });
	await page
		.getByRole("menu", { name: "Actions for two.txt" })
		.getByRole("menuitem", { name: "Close tab" })
		.click();
	await expect(tabs(page)).toHaveCount(2);
	await expect(selected).toBeFocused();

	// Delete on the focused, selected tab closes it and selects a neighbour.
	const before = (await selected.getAttribute("data-testid")) ?? "";
	await page.keyboard.press("Delete");
	await expect(tabs(page)).toHaveCount(1);
	await expect(selected).not.toHaveAttribute("data-testid", before);
	await expect(selected).toBeFocused();
});

test("a pane moves into another tab from its actions menu", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	const project = await createProject(student.workspaceId, { name: "Move into" });
	// Narrow, so the submenu has to find room beside a menu near the edge.
	await page.setViewportSize({ width: 640, height: 800 });
	await page.goto(workspacePath(student.workspaceId, project.id));
	await expect(workTabs(page)).toBeVisible({ timeout: 15_000 });
	const first = await openTerminal(page, student.workspaceId, project.id, 1);
	const second = await openTerminal(page, student.workspaceId, project.id, 2);
	await expect(tabs(page)).toHaveCount(2);

	const menu = await paneMenu(page, second);
	await menu.getByRole("menuitem", { name: "Move into" }).click();
	const submenu = page.getByRole("menu", { name: "Move into" });
	await expect(submenu.getByRole("menuitem")).toHaveCount(1);
	await scanInBothThemes(page, "pane-move-into");
	const target = submenu.getByTestId(`terminal-move-into-${first}`);
	// Glide across as a hand would: Radix closes a submenu the pointer
	// jumps out of in one step, which Playwright's own click does.
	const box = await target.boundingBox();
	if (!box) throw new Error("the submenu item is not on screen");
	await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 5 });
	await target.click();

	// One tab now holds both panes side by side, the moved one on the right.
	await expect(tabs(page)).toHaveCount(1);
	const group = page.getByTestId(`terminal-group-${first}`);
	await expect(group.locator('[data-group][data-direction="row"]')).toHaveCount(1);
	const order = await group
		.locator('[data-testid^="terminal-leaf-"]')
		.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-testid")));
	expect(order).toEqual([`terminal-leaf-${first}`, `terminal-leaf-${second}`]);
	await expect(page.getByTestId(`terminal-leaf-${second}`)).toBeVisible();

	// With every pane in one tab there is nowhere left to move into.
	const again = await paneMenu(page, second);
	await expect(again.getByRole("menuitem", { name: "Move into" })).toHaveAttribute(
		"aria-disabled",
		"true",
	);
});

test("Reset pane sizes shares a split out evenly again", async ({ page, context }) => {
	const student = await createStudent(context);
	const project = await createProject(student.workspaceId, { name: "Reset sizes" });
	await page.goto(workspacePath(student.workspaceId, project.id));
	await expect(workTabs(page)).toBeVisible({ timeout: 15_000 });
	const first = await openTerminal(page, student.workspaceId, project.id, 1);

	// Alone in its tab, the pane has nothing to reset.
	const alone = await paneMenu(page, first);
	await expect(
		alone.getByRole("menuitem", { name: "Reset pane sizes" }),
	).toHaveAttribute("aria-disabled", "true");
	await alone.getByRole("menuitem", { name: "Split right" }).click();
	await expect
		.poll(async () => (await terminalIds(student.workspaceId, project.id)).length)
		.toBe(2);
	const second = (await terminalIds(student.workspaceId, project.id)).find(
		(id) => id !== first,
	) as string;
	await expectConnected(page, second);

	// Make the split uneven with the splitter's own End key, which gives the
	// first pane all the room the second pane's minimum leaves.
	await page.getByRole("separator", { name: "Resize panes" }).focus();
	await page.keyboard.press("End");
	const widths = async () =>
		Promise.all(
			[first, second].map(async (id) => {
				const box = await page.getByTestId(`terminal-leaf-${id}`).boundingBox();
				return box?.width ?? 0;
			}),
		);
	await expect
		.poll(
			async () => {
				const [left = 0, right = 0] = await widths();
				return left > right * 2;
			},
			{ timeout: 15_000 },
		)
		.toBe(true);

	const menu = await paneMenu(page, first);
	await scanInBothThemes(page, "pane-reset-sizes");
	await menu.getByRole("menuitem", { name: "Reset pane sizes" }).click();

	await expect
		.poll(async () => {
			const [left = 0, right = 0] = await widths();
			return Math.abs(left - right);
		})
		.toBeLessThan(4);
	// The even sizes are what the next visit gets.
	await expect
		.poll(
			async () => {
				const rows = await query<{
					layout: { tabs: { root: { sizes?: number[] } }[] };
				}>("select layout from projects where id = $1", [project.id]);
				return rows[0]?.layout.tabs[0]?.root.sizes;
			},
			{ timeout: 10_000 },
		)
		.toEqual([50, 50]);
});
