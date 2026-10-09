/**
 * File panes in a split beside a terminal (SPEC.md §7.5, §8.3, §9.3, §25.8):
 * dragging a file onto a terminal's edge, the menu way to do the same, closing,
 * the unsaved dot, a reload, and the accessibility scan.
 */
import { expect, type Page, test } from "@playwright/test";
import {
	createStudent,
	expectConnected,
	expectNoViolations,
	newTerminal,
	openFileTab,
	query,
	readSeededFile,
	type TestStudent,
	terminalIds,
	workTabs,
} from "./helpers";
import { WEB_ORIGIN } from "./ports";

const PATH = "src/app.ts";
const FILE_PANE = `file:${PATH}`;

test.describe("file panes in splits", () => {
	// Monaco is a large chunk the dev server transforms on first use.
	test.describe.configure({ timeout: 90_000 });

	/**
	 * A project with src/app.ts open as a tab of its own and one terminal in
	 * a second tab, which is the active one. Returns the terminal's id, which
	 * is also its tab's id.
	 */
	async function fileAndTerminal(
		page: Page,
		student: TestStudent,
		name: string,
	): Promise<{ projectId: string; slug: string; terminalId: string }> {
		const project = await openFileTab(
			page,
			student,
			name,
			PATH,
			"const answer = 42;\n",
		);
		await expect(lines(page)).toContainText("const answer = 42;", { timeout: 60_000 });
		await newTerminal(page);
		await expect
			.poll(async () => (await terminalIds(student.workspaceId, project.id)).length)
			.toBe(1);
		const [terminalId] = await terminalIds(student.workspaceId, project.id);
		if (!terminalId) throw new Error("the terminal row was not created");
		await expectConnected(page, terminalId);
		return { projectId: project.id, slug: project.slug, terminalId };
	}

	function lines(page: Page) {
		return page.getByTestId(`editor-${PATH}`).locator(".view-lines");
	}

	/** The panes of one tab, in the order they are laid out. */
	async function panesIn(page: Page, tabId: string): Promise<string[]> {
		return page
			.getByTestId(`terminal-group-${tabId}`)
			.locator('[data-testid^="terminal-leaf-"], [data-testid^="file-frame-"]')
			.evaluateAll((nodes) =>
				nodes
					.map((node) => node.getAttribute("data-testid") ?? "")
					.filter((id) => !id.startsWith("file-frame-handle-"))
					.filter((id) => !id.startsWith("file-frame-actions-")),
			);
	}

	/** Choose "Move into" the given tab from the file pane's menu, by keyboard only. */
	async function moveFileInto(page: Page, tabId: string) {
		await page.getByTestId(`file-frame-actions-${PATH}`).focus();
		await page.keyboard.press("Enter");
		const moveInto = page.getByRole("menuitem", { name: "Move into" });
		await expect(moveInto).toBeVisible();
		await moveInto.focus();
		await page.keyboard.press("ArrowRight");
		const target = page
			.getByRole("menu", { name: "Move into" })
			.getByTestId(`file-frame-move-into-${tabId}`);
		await expect(target).toBeFocused();
		await page.keyboard.press("Enter");
	}

	/** Wait for the saved layout to hold the file inside a split. */
	async function waitForSavedSplit(projectId: string): Promise<void> {
		await expect
			.poll(
				async () => {
					const rows = await query<{ layout: { tabs: { root: unknown }[] } | null }>(
						"select layout from projects where id = $1",
						[projectId],
					);
					const tabs = rows[0]?.layout?.tabs ?? [];
					return (
						tabs.length === 1 &&
						JSON.stringify(tabs[0]?.root).includes('"type":"split"') &&
						JSON.stringify(tabs[0]?.root).includes(`"path":"${PATH}"`)
					);
				},
				{ timeout: 10_000 },
			)
			.toBe(true);
	}

	test("a file dragged onto a terminal's right edge opens beside it", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const { projectId, terminalId } = await fileAndTerminal(page, student, "Drag file");

		// Grab the file's title bar in its own tab.
		await page.getByTestId(`tab-${FILE_PANE}`).click();
		const handle = page.getByTestId(`file-frame-handle-${PATH}`);
		const box = await handle.boundingBox();
		if (!box) throw new Error("the file pane has no title bar");
		await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
		await page.mouse.down();

		// Rest on the terminal's tab until it opens, then go to the pane's edge.
		const tab = await page.getByTestId(`tab-${terminalId}`).boundingBox();
		if (!tab) throw new Error("the terminal tab is not on screen");
		await page.mouse.move(tab.x + tab.width / 2, tab.y + tab.height / 2, { steps: 12 });
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

		// One tab: the terminal on the left, the file on its right.
		await expect(workTabs(page).getByRole("tab")).toHaveCount(1);
		expect(await panesIn(page, terminalId)).toEqual([
			`terminal-leaf-${terminalId}`,
			`file-frame-${PATH}`,
		]);
		await expect(lines(page)).toContainText("const answer = 42;");
		await expectConnected(page, terminalId);
		await page.screenshot({ path: "screenshots/file-split-drag.png" });

		// A reload puts the file back beside the terminal.
		await waitForSavedSplit(projectId);
		await page.reload();
		await expect(page.getByTestId(`file-frame-${PATH}`)).toBeVisible({
			timeout: 15_000,
		});
		expect(await panesIn(page, terminalId)).toEqual([
			`terminal-leaf-${terminalId}`,
			`file-frame-${PATH}`,
		]);
		await expect(lines(page)).toContainText("const answer = 42;", { timeout: 60_000 });
	});

	test("the menu moves a file with unsaved edits into the terminal's tab without losing them", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const { slug, terminalId } = await fileAndTerminal(page, student, "Menu move");
		await page.getByTestId(`tab-${FILE_PANE}`).click();

		// Type, then move before the auto-save delay has run out.
		await lines(page).click();
		await page.keyboard.press("End");
		await page.keyboard.type(" // moved");
		await expect(page.getByTestId(`tab-${FILE_PANE}-dirty`)).toBeVisible();
		await moveFileInto(page, terminalId);

		await expect(workTabs(page).getByRole("tab")).toHaveCount(1);
		expect(await panesIn(page, terminalId)).toEqual([
			`terminal-leaf-${terminalId}`,
			`file-frame-${PATH}`,
		]);
		// The keyboard followed the pane to its new place.
		await expect(page.getByTestId(`file-frame-actions-${PATH}`)).toBeFocused();
		// The pane mounted again, so its pending edit was written on the way.
		await expect
			.poll(async () => readSeededFile(student.workspaceId, slug, PATH), {
				timeout: 15_000,
			})
			.toContain("// moved");
		await expect(lines(page)).toContainText("// moved", { timeout: 15_000 });
	});

	test("with auto-save off, a file moved into a split keeps its unsaved edits unwritten", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const res = await page.request.put("/me/settings", {
			data: { autoSave: false },
			headers: { origin: WEB_ORIGIN },
		});
		expect(res.status()).toBe(200);
		const { slug, terminalId } = await fileAndTerminal(page, student, "Move off");
		await page.getByTestId(`tab-${FILE_PANE}`).click();
		await lines(page).click();
		await page.keyboard.press("Control+Home");
		await page.keyboard.press("End");
		await page.keyboard.type(" // kept");
		await moveFileInto(page, terminalId);

		await expect(page.getByTestId(`file-frame-${PATH}`)).toBeVisible();
		await expect(lines(page)).toContainText("// kept", { timeout: 15_000 });
		await expect(page.getByTestId(`file-status-${PATH}`)).toHaveText("Unsaved");
		await expect(page.getByTestId(`tab-${terminalId}-dirty`)).toBeVisible();
		expect(await readSeededFile(student.workspaceId, slug, PATH)).toBe(
			"const answer = 42;\n",
		);
	});

	test("the tab shows the unsaved dot for a file inside it", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const { terminalId } = await fileAndTerminal(page, student, "Dirty split");
		await page.getByTestId(`tab-${FILE_PANE}`).click();
		await moveFileInto(page, terminalId);
		await expect(page.getByTestId(`file-frame-${PATH}`)).toBeVisible();

		await expect(page.getByTestId(`tab-${terminalId}-dirty`)).toHaveCount(0);
		await lines(page).click();
		await page.keyboard.press("End");
		await page.keyboard.type(" // dirty");
		await expect(page.getByTestId(`tab-${terminalId}-dirty`)).toBeVisible();
		// Ctrl+S writes it, and the dot goes.
		await page.keyboard.press("Control+s");
		await expect(page.getByTestId(`tab-${terminalId}-dirty`)).toHaveCount(0, {
			timeout: 15_000,
		});
	});

	test("closing the file from its menu leaves the terminal", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const { terminalId } = await fileAndTerminal(page, student, "Close file");
		await page.getByTestId(`tab-${FILE_PANE}`).click();
		await moveFileInto(page, terminalId);
		await expect(page.getByTestId(`file-frame-${PATH}`)).toBeVisible();

		await page.getByTestId(`file-frame-actions-${PATH}`).click();
		await page.getByTestId("file-frame-close").click();
		await expect(page.getByTestId(`file-frame-${PATH}`)).toHaveCount(0);
		expect(await panesIn(page, terminalId)).toEqual([`terminal-leaf-${terminalId}`]);
		await expect(workTabs(page).getByRole("tab")).toHaveCount(1);
		await expectConnected(page, terminalId);
		// The keyboard goes to the terminal beside it, not to the page.
		await expect(
			page.getByTestId(`terminal-pane-${terminalId}`).locator(".xterm-helper-textarea"),
		).toBeFocused();
	});

	test("closing the terminal beside a file hands the keyboard to the file", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const { terminalId } = await fileAndTerminal(page, student, "Close terminal");
		await page.getByTestId(`tab-${FILE_PANE}`).click();
		await moveFileInto(page, terminalId);
		await expect(page.getByTestId(`file-frame-${PATH}`)).toBeVisible();

		await page.getByTestId(`terminal-actions-${terminalId}`).click();
		await page.getByTestId("terminal-close").click();
		await expect(page.getByTestId(`terminal-leaf-${terminalId}`)).toHaveCount(0, {
			timeout: 15_000,
		});
		await expect(page.getByTestId(`tab-${FILE_PANE}`)).toBeVisible();
		await expect
			.poll(() =>
				page.evaluate(
					(path) =>
						document.activeElement?.closest(`[data-testid="file-frame-${path}"]`) !==
						null,
					PATH,
				),
			)
			.toBe(true);
	});

	test("closing a tab whose file has unsaved edits asks first", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const res = await page.request.put("/me/settings", {
			data: { autoSave: false },
			headers: { origin: WEB_ORIGIN },
		});
		expect(res.status()).toBe(200);
		const { projectId, slug, terminalId } = await fileAndTerminal(
			page,
			student,
			"Close unsaved",
		);
		await page.getByTestId(`tab-${FILE_PANE}`).click();
		await moveFileInto(page, terminalId);
		await expect(page.getByTestId(`file-frame-${PATH}`)).toBeVisible();
		await lines(page).click();
		await page.keyboard.press("End");
		await page.keyboard.type(" // unsaved");
		await expect(page.getByTestId(`tab-${terminalId}-dirty`)).toBeVisible();

		await page.getByTestId(`tab-${terminalId}`).focus();
		await page.keyboard.press("Delete");
		const dialog = page.getByRole("alertdialog", { name: "Close this tab?" });
		await expect(dialog).toContainText(
			"app.ts has changes that are not saved. Closing the tab discards them and ends its terminal.",
		);
		for (const colorScheme of ["light", "dark"] as const) {
			await page.emulateMedia({ colorScheme });
			await expectNoViolations(page);
			await page.screenshot({ path: `screenshots/close-unsaved-${colorScheme}.png` });
		}
		await page.setViewportSize({ width: 480, height: 800 });
		await page.screenshot({ path: "screenshots/close-unsaved-narrow-dark.png" });
		await dialog.getByRole("button", { name: "Cancel" }).click();
		await expect(page.getByTestId(`file-frame-${PATH}`)).toBeVisible();
		expect(await terminalIds(student.workspaceId, projectId)).toEqual([terminalId]);

		await page.getByTestId(`tab-${terminalId}`).focus();
		await page.keyboard.press("Delete");
		await dialog.getByRole("button", { name: "Close tab" }).click();
		await expect(workTabs(page).getByRole("tab")).toHaveCount(0, { timeout: 15_000 });
		expect(await readSeededFile(student.workspaceId, slug, PATH)).toBe(
			"const answer = 42;\n",
		);
	});

	test("closing the tab closes the file and the terminal in it", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const { projectId, terminalId } = await fileAndTerminal(page, student, "Close tab");
		await page.getByTestId(`tab-${FILE_PANE}`).click();
		await moveFileInto(page, terminalId);
		await expect(page.getByTestId(`file-frame-${PATH}`)).toBeVisible();

		await page.getByTestId(`tab-${terminalId}-close`).click();
		await expect(workTabs(page).getByRole("tab")).toHaveCount(0, { timeout: 15_000 });
		await expect(page.getByTestId(`file-frame-${PATH}`)).toHaveCount(0);
		await expect
			.poll(async () => (await terminalIds(student.workspaceId, projectId)).length)
			.toBe(0);
	});

	test("a split of a file and a terminal has no axe violations", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const { terminalId } = await fileAndTerminal(page, student, "Axe split");
		await page.getByTestId(`tab-${FILE_PANE}`).click();
		await moveFileInto(page, terminalId);
		await expect(page.getByTestId(`file-frame-${PATH}`)).toBeVisible();
		for (const colorScheme of ["light", "dark"] as const) {
			await page.emulateMedia({ colorScheme });
			await expectNoViolations(page, '[data-testid="work-area"]');
			await page.screenshot({ path: `screenshots/file-split-${colorScheme}.png` });
		}
	});
});
