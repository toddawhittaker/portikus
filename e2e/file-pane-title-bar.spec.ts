/**
 * A file pane's title bar (SPEC.md §8.3, §9.3, §25.8): its empty space starts
 * the same pane drag as a terminal's bar, its buttons never start a drag, and
 * a 200-character file name truncates rather than squeezing the editor's
 * controls below the 24-pixel target size (WCAG 2.5.8).
 */
import { expect, type Locator, type Page, test } from "@playwright/test";
import {
	createProject,
	createStudent,
	expectConnected,
	expectNoViolations,
	newTerminal,
	openFileTab,
	query,
	seedFile,
	terminalIds,
	workspacePath,
} from "./helpers";

const PATH = "src/app.ts";
/** One unbroken name of 200 characters, the worst case for the header. */
const LONG = `src/${"a".repeat(197)}.ts`;

async function expectTargetSize(target: Locator): Promise<void> {
	const box = await target.boundingBox();
	expect(box?.width ?? 0).toBeGreaterThanOrEqual(24);
	expect(box?.height ?? 0).toBeGreaterThanOrEqual(24);
}

/** The control is drawn inside its pane, not pushed past the edge. */
async function expectInside(target: Locator, frame: Box | null): Promise<void> {
	const box = await target.boundingBox();
	expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(
		(frame?.x ?? 0) + (frame?.width ?? 0) + 1,
	);
}

type Box = { x: number; y: number; width: number; height: number };

/** The panes of one tab, in the order they are laid out. */
async function panesIn(page: Page, tabId: string): Promise<string[]> {
	return page
		.getByTestId(`terminal-group-${tabId}`)
		.locator('[data-testid^="terminal-leaf-"], section[data-testid^="file-frame-"]')
		.evaluateAll((nodes) =>
			nodes.map((node) => node.getAttribute("data-testid") ?? ""),
		);
}

for (const colorScheme of ["light", "dark"] as const) {
	test.describe(`file pane title bar (${colorScheme})`, () => {
		// Monaco is a large chunk the dev server transforms on first use.
		test.describe.configure({ timeout: 120_000 });

		test.beforeEach(async ({ page }) => {
			await page.emulateMedia({ colorScheme });
		});

		test("a 200-character file name truncates and every control keeps its size", async ({
			page,
			context,
		}) => {
			const student = await createStudent(context);
			const project = await createProject(student.workspaceId, { name: "Long name" });
			await seedFile(student.workspaceId, project.slug, LONG, "const answer = 42;\n");
			await seedFile(student.workspaceId, project.slug, PATH, "const other = 1;\n");
			const file = (path: string) => ({ type: "file", path });
			const layouts = {
				// Alone in its tab, as wide as the work area.
				wide: { id: `file:${LONG}`, root: file(LONG) },
				// A third of a split, narrow enough to put its controls on a second row.
				narrow: {
					// A split tab is named like a terminal tab, not by a path.
					id: "long-split",
					root: {
						type: "split",
						direction: "row",
						sizes: [30, 70],
						children: [file(LONG), file(PATH)],
					},
				},
			};
			const frame = page.getByTestId(`file-frame-${LONG}`);
			const name = page.getByTestId(`file-frame-handle-${LONG}`);
			for (const [label, tab] of Object.entries(layouts)) {
				await query("update projects set layout = $2 where id = $1", [
					project.id,
					JSON.stringify({ tabs: [tab] }),
				]);
				await page.goto(workspacePath(student.workspaceId, project.id));
				await expect(
					page.getByTestId(`editor-${LONG}`).locator(".view-lines"),
				).toContainText("const answer = 42;", { timeout: 60_000 });
				const frameBox = await frame.boundingBox();
				// The name truncates inside the pane rather than widening it.
				const nameBox = await name.boundingBox();
				expect((nameBox?.x ?? 0) + (nameBox?.width ?? 0)).toBeLessThanOrEqual(
					(frameBox?.x ?? 0) + (frameBox?.width ?? 0),
				);
				expect(await name.evaluate((node) => node.scrollWidth > node.clientWidth)).toBe(
					true,
				);
				for (const zoom of ["Zoom out", "Zoom in", "Reset"]) {
					const target = frame.getByRole("button", { name: zoom, exact: true });
					await expectTargetSize(target);
					await expectInside(target, frameBox);
				}
				const actions = frame.getByRole("button", { name: /^Actions for / });
				await expectTargetSize(actions);
				await expectInside(actions, frameBox);
				await page.screenshot({
					path: `screenshots/file-pane-long-name-${label}-${colorScheme}.png`,
				});
				// The whole page, so a neighbour such as a toast counts too.
				await expectNoViolations(page);
			}
		});

		test("a file pane drags by the empty space in its title bar, not by its buttons", async ({
			page,
			context,
		}) => {
			const student = await createStudent(context);
			const project = await openFileTab(
				page,
				student,
				"Drag bar",
				PATH,
				"const answer = 42;\n",
			);
			await expect(
				page.getByTestId(`editor-${PATH}`).locator(".view-lines"),
			).toContainText("const answer = 42;", { timeout: 60_000 });
			await newTerminal(page);
			await expect
				.poll(async () => (await terminalIds(student.workspaceId, project.id)).length)
				.toBe(1);
			const [terminalId] = await terminalIds(student.workspaceId, project.id);
			if (!terminalId) throw new Error("the terminal row was not created");
			await expectConnected(page, terminalId);
			await page.getByTestId(`tab-file:${PATH}`).click();

			const header = page.getByTestId(`file-frame-${PATH}`).locator("header");
			const bar = await header.boundingBox();
			const name = await page.getByTestId(`file-frame-handle-${PATH}`).boundingBox();
			const tools = await header.locator(".pk-file-tools").boundingBox();
			if (!bar || !name || !tools) throw new Error("the file pane has no title bar");

			// Pressing a header button and moving off it starts no drag.
			const button = page.getByTestId(`file-view-edit-${PATH}`);
			const pressed = await button.boundingBox();
			if (!pressed) throw new Error("the view buttons are not on screen");
			await page.mouse.move(
				pressed.x + pressed.width / 2,
				pressed.y + pressed.height / 2,
			);
			await page.mouse.down();
			await page.mouse.move(pressed.x + pressed.width / 2, pressed.y + 200, {
				steps: 8,
			});
			await expect(page.getByTestId("pane-drag-overlay")).toHaveCount(0);
			await page.mouse.up();

			// Press-dragging across the folder path selects it, so it can be copied,
			// and starts no drag.
			const dir = page.getByTestId(`file-header-dir-${PATH}`);
			const folder = await dir.boundingBox();
			if (!folder) throw new Error("the folder path is not on screen");
			const middle = folder.y + folder.height / 2;
			await page.mouse.move(folder.x + 1, middle);
			await page.mouse.down();
			await page.mouse.move(folder.x + folder.width - 1, middle, { steps: 8 });
			await expect(page.getByTestId("pane-drag-overlay")).toHaveCount(0);
			await page.mouse.up();
			expect(
				await page.evaluate(() => window.getSelection()?.toString() ?? ""),
			).toMatch(/sr/);
			await page.evaluate(() => window.getSelection()?.removeAllRanges());
			await expect(dir).toHaveCSS("cursor", "text");

			// A click on a header button still does its job.
			await page.getByTestId(`file-view-diff-${PATH}`).click();
			await expect(page.getByTestId(`diff-pane-${PATH}`)).toBeVisible();
			// The diff's header is the same bar: its empty space starts the drag,
			// and Escape puts the pane back.
			const diffHeader = page.getByTestId(`diff-pane-${PATH}`).locator("header");
			const diffBar = await diffHeader.boundingBox();
			const diffTools = await diffHeader.locator(".pk-file-tools").boundingBox();
			if (!diffBar || !diffTools) throw new Error("the diff has no title bar");
			const diffStart = { x: diffTools.x - 8, y: diffBar.y + diffBar.height / 2 };
			await page.mouse.move(diffStart.x, diffStart.y);
			await page.mouse.down();
			await page.mouse.move(diffStart.x - 10, diffStart.y + 10, { steps: 4 });
			await expect(page.getByTestId("pane-drag-overlay")).toBeVisible();
			await page.keyboard.press("Escape");
			await expect(page.getByTestId("pane-drag-overlay")).toHaveCount(0);
			await page.mouse.up();
			// dnd-kit swallows clicks for 50 ms after a drag ends, so retry.
			await expect(async () => {
				await page.getByTestId(`file-view-edit-${PATH}`).click();
				await expect(page.getByTestId(`file-pane-${PATH}`)).toBeVisible({
					timeout: 500,
				});
			}).toPass();

			// Grab the bar between the name and the controls, away from both.
			const start = {
				x: (name.x + name.width + tools.x) / 2,
				y: bar.y + bar.height / 2,
			};
			expect(start.x).toBeGreaterThan(name.x + name.width + 8);
			await page.mouse.move(start.x, start.y);
			await page.mouse.down();
			await page.mouse.move(start.x + 10, start.y + 10, { steps: 4 });
			await expect(page.getByTestId("pane-drag-overlay")).toBeVisible();

			// Rest on the terminal's tab until it opens, then go to the pane's edge.
			const tab = await page.getByTestId(`tab-${terminalId}`).boundingBox();
			if (!tab) throw new Error("the terminal tab is not on screen");
			await page.mouse.move(tab.x + tab.width / 2, tab.y + tab.height / 2, {
				steps: 12,
			});
			await expect(page.getByTestId(`terminal-group-${terminalId}`)).toBeVisible();
			const pane = await page.getByTestId(`terminal-leaf-${terminalId}`).boundingBox();
			if (!pane) throw new Error("the terminal pane is not on screen");
			const edge = { x: pane.x + pane.width * 0.9, y: pane.y + pane.height * 0.5 };
			await page.mouse.move(edge.x, edge.y, { steps: 12 });
			await page.mouse.move(edge.x, edge.y, { steps: 2 });
			await expect(page.getByTestId(`drop-zone-${terminalId}`)).toHaveAttribute(
				"data-edge",
				"right",
			);
			await page.mouse.up();

			await expect
				.poll(() => panesIn(page, terminalId))
				.toEqual([`terminal-leaf-${terminalId}`, `file-frame-${PATH}`]);
			await page.screenshot({
				path: `screenshots/file-pane-dragged-by-bar-${colorScheme}.png`,
			});
			await expectNoViolations(page, `[data-testid="file-frame-${PATH}"] header`);
		});
	});
}
