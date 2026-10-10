/**
 * A file dragged from the tree onto a pane's edge opens in a split there, or
 * moves its pane there when it is already open (SPEC.md §9.3). Folder drops
 * in the tree keep moving files.
 */
import { expect, type Page, test } from "@playwright/test";
import {
	createProject,
	createStudent,
	expectConnected,
	newTerminal,
	readSeededFile,
	seedFile,
	seedGit,
	type TestStudent,
	terminalIds,
	workspacePath,
	workTabs,
} from "./helpers";

test.describe("tree file dragged onto a pane edge", () => {
	// Monaco is a large chunk the dev server transforms on first use.
	test.describe.configure({ timeout: 90_000 });

	function row(page: Page, path: string) {
		return page.getByTestId(`file-row-${path}`);
	}

	/** A project with two files and a folder, showing one terminal. */
	async function setUp(page: Page, student: TestStudent, name: string) {
		const project = await createProject(student.workspaceId, { name });
		await seedFile(student.workspaceId, project.slug, "notes.md", "# notes\n");
		await seedFile(student.workspaceId, project.slug, "other.md", "# other\n");
		await seedFile(student.workspaceId, project.slug, "lib/keep.txt", "keep\n");
		await page.goto(workspacePath(student.workspaceId, project.id));
		await expect(row(page, "notes.md")).toBeVisible({ timeout: 15_000 });
		await newTerminal(page);
		await expect
			.poll(async () => (await terminalIds(student.workspaceId, project.id)).length)
			.toBe(1);
		const [terminalId] = await terminalIds(student.workspaceId, project.id);
		if (!terminalId) throw new Error("the terminal row was not created");
		await expectConnected(page, terminalId);
		return { project, terminalId };
	}

	/** Press on a tree row and carry it to a point, without letting go. */
	async function carryRow(page: Page, path: string, to: { x: number; y: number }) {
		const source = await row(page, path).boundingBox();
		if (!source) throw new Error(`the row ${path} is not on screen`);
		await page.mouse.move(source.x + 20, source.y + 10);
		await page.mouse.down();
		await page.mouse.move(source.x + 30, source.y + 10, { steps: 5 });
		await page.mouse.move(to.x, to.y, { steps: 12 });
		await page.mouse.move(to.x, to.y, { steps: 2 });
	}

	async function rightEdgeOf(page: Page, testId: string) {
		const box = await page.getByTestId(testId).boundingBox();
		if (!box) throw new Error(`${testId} is not on screen`);
		return { x: box.x + box.width * 0.9, y: box.y + box.height * 0.5 };
	}

	async function bottomEdgeOf(page: Page, testId: string) {
		const box = await page.getByTestId(testId).boundingBox();
		if (!box) throw new Error(`${testId} is not on screen`);
		return { x: box.x + box.width * 0.5, y: box.y + box.height * 0.9 };
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

	test("a file dropped on a terminal's right edge, then one on a file's bottom edge, open in splits", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const { terminalId } = await setUp(page, student, "Tree split");

		await carryRow(
			page,
			"notes.md",
			await rightEdgeOf(page, `terminal-leaf-${terminalId}`),
		);
		await expect(page.getByTestId(`drop-zone-${terminalId}`)).toHaveAttribute(
			"data-edge",
			"right",
		);
		await page.mouse.up();

		await expect(workTabs(page).getByRole("tab")).toHaveCount(1);
		await expect
			.poll(() => panesIn(page, terminalId))
			.toEqual([`terminal-leaf-${terminalId}`, "file-frame-notes.md"]);
		await expect(page.getByTestId("drop-zone-file:notes.md")).toHaveCount(0);

		await carryRow(page, "other.md", await bottomEdgeOf(page, "file-frame-notes.md"));
		await expect(page.getByTestId("drop-zone-file:notes.md")).toHaveAttribute(
			"data-edge",
			"bottom",
		);
		await page.mouse.up();

		await expect(workTabs(page).getByRole("tab")).toHaveCount(1);
		await expect
			.poll(() => panesIn(page, terminalId))
			.toEqual([
				`terminal-leaf-${terminalId}`,
				"file-frame-notes.md",
				"file-frame-other.md",
			]);
		await page.screenshot({ path: "screenshots/tree-drag-split.png" });
	});

	test("an already open file dropped on a pane edge moves there, not twice", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const { terminalId } = await setUp(page, student, "Tree move");

		// Open notes.md in a tab of its own, then go back to the terminal.
		await row(page, "notes.md").click();
		await expect(page.getByTestId("tab-file:notes.md")).toBeVisible();
		await page.getByTestId(`tab-${terminalId}`).click();
		await expect(page.getByTestId(`terminal-group-${terminalId}`)).toBeVisible();

		await carryRow(
			page,
			"notes.md",
			await rightEdgeOf(page, `terminal-leaf-${terminalId}`),
		);
		await expect(page.getByTestId(`drop-zone-${terminalId}`)).toHaveAttribute(
			"data-edge",
			"right",
		);
		await page.mouse.up();

		await expect(workTabs(page).getByRole("tab")).toHaveCount(1);
		await expect
			.poll(() => panesIn(page, terminalId))
			.toEqual([`terminal-leaf-${terminalId}`, "file-frame-notes.md"]);
		await expect(page.getByTestId("file-frame-notes.md")).toHaveCount(1);
	});

	test("an open file in Diff view dropped on a pane edge stays in Diff view", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const { project, terminalId } = await setUp(page, student, "Tree diff move");
		await seedGit(student.workspaceId, project.slug, {
			diffs: {
				"notes.md": {
					status: "M",
					before: "# old\n",
					after: "# notes\n",
					binary: false,
					tooLarge: false,
				},
			},
		});

		await row(page, "notes.md").click();
		await page.getByTestId("file-view-diff-notes.md").click();
		await expect(page.getByTestId("diff-editor-notes.md")).toBeVisible({
			timeout: 60_000,
		});
		await page.getByTestId(`tab-${terminalId}`).click();
		await expect(page.getByTestId(`terminal-group-${terminalId}`)).toBeVisible();

		await carryRow(
			page,
			"notes.md",
			await rightEdgeOf(page, `terminal-leaf-${terminalId}`),
		);
		await page.mouse.up();

		await expect
			.poll(() => panesIn(page, terminalId))
			.toEqual([`terminal-leaf-${terminalId}`, "file-frame-notes.md"]);
		const group = page.getByTestId(`terminal-group-${terminalId}`);
		await expect(group.getByTestId("diff-editor-notes.md")).toBeVisible({
			timeout: 30_000,
		});
	});

	test("a folder row gives no pane edge, and a tree folder drop still moves the file", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const { project, terminalId } = await setUp(page, student, "Tree folder");

		await carryRow(page, "lib", await rightEdgeOf(page, `terminal-leaf-${terminalId}`));
		await expect(page.getByTestId(`drop-zone-${terminalId}`)).toHaveCount(0);
		await page.mouse.up();
		await expect(workTabs(page).getByRole("tab")).toHaveCount(1);

		const folder = row(page, "lib").locator(":scope > .pk-tree-row");
		const target = await folder.boundingBox();
		if (!target) throw new Error("the folder row is not on screen");
		await carryRow(page, "notes.md", {
			x: target.x + 40,
			y: target.y + target.height / 2,
		});
		await expect(folder).toHaveClass(/is-drop-target/);
		await page.mouse.up();

		await expect(row(page, "notes.md")).toHaveCount(0);
		await expect
			.poll(() => readSeededFile(student.workspaceId, project.slug, "lib/notes.md"))
			.toBe("# notes\n");
		await expect(workTabs(page).getByRole("tab")).toHaveCount(1);
	});
});
