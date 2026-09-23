import { expect, type Page, test } from "@playwright/test";
import {
	createProject,
	createStudent,
	newTerminal,
	query,
	seedFile,
	seedGit,
	type TestProject,
	type TestStudent,
	workspacePath,
	workTabs,
} from "./helpers";

/**
 * The diff tab: HEAD against the working tree for one file, every Git status
 * it can be in, and the two cases that cannot be shown side by side
 * (SPEC.md §12.6).
 */
test.describe("diff tab", () => {
	// Monaco is a large chunk the dev server transforms on first use, so the
	// first run of this file is much slower than the rest of the suite.
	test.describe.configure({ timeout: 90_000 });

	const PATH = "src/app.ts";

	/** Open a project whose saved layout already has one diff tab. */
	async function openDiffTab(
		page: Page,
		student: TestStudent,
		name: string,
		diffs: Record<string, unknown>,
		path = PATH,
	): Promise<TestProject> {
		const project = await createProject(student.workspaceId, { name });
		await seedGit(student.workspaceId, project.slug, { diffs });
		await query("update projects set layout = $2 where id = $1", [
			project.id,
			JSON.stringify({
				tabs: [{ id: `diff:${path}`, root: { type: "diff", path } }],
			}),
		]);
		await page.goto(workspacePath(student.workspaceId, project.id));
		await expect(page.getByTestId(`diff-pane-${path}`)).toBeVisible({
			timeout: 15_000,
		});
		return project;
	}

	function diff(overrides: Record<string, unknown> = {}) {
		return {
			status: "M",
			before: "const answer = 1;\n",
			after: "const answer = 42;\n",
			binary: false,
			tooLarge: false,
			...overrides,
		};
	}

	test("a modified file opens side by side with both versions", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		await openDiffTab(page, student, "Modified", { [PATH]: diff() });

		await expect(page.getByTestId(`diff-status-${PATH}`)).toHaveText("M");
		const editor = page.getByTestId(`diff-editor-${PATH}`);
		await expect(editor.locator(".monaco-diff-editor")).toBeVisible({
			timeout: 60_000,
		});
		await expect(editor).toContainText("const answer = 1;");
		await expect(editor).toContainText("const answer = 42;");
		// A modified file needs no explanation.
		await expect(page.getByTestId("diff-note")).toHaveCount(0);
	});

	test("a new file is shown as added", async ({ page, context }) => {
		const student = await createStudent(context);
		await openDiffTab(page, student, "Added", {
			[PATH]: diff({ status: "A", before: null, after: "brand new\n" }),
		});

		await expect(page.getByTestId(`diff-status-${PATH}`)).toHaveText("A");
		await expect(page.getByTestId("diff-note")).toHaveText("New file (not in HEAD)");
		await expect(page.getByTestId(`diff-editor-${PATH}`)).toContainText("brand new", {
			timeout: 60_000,
		});
	});

	test("a deleted file is shown from HEAD", async ({ page, context }) => {
		const student = await createStudent(context);
		await openDiffTab(page, student, "Deleted", {
			[PATH]: diff({ status: "D", before: "was here\n", after: null }),
		});

		await expect(page.getByTestId(`diff-status-${PATH}`)).toHaveText("D");
		await expect(page.getByTestId("diff-note")).toHaveText(
			"Deleted from the working tree",
		);
		await expect(page.getByTestId(`diff-editor-${PATH}`)).toContainText("was here", {
			timeout: 60_000,
		});
		// There is no file left to open.
		await expect(page.getByTestId(`diff-open-${PATH}`)).toHaveCount(0);
	});

	test("a rename shows the old path and the new one", async ({ page, context }) => {
		const student = await createStudent(context);
		await openDiffTab(page, student, "Renamed", {
			[PATH]: diff({ status: "R", oldPath: "src/old.ts" }),
		});

		await expect(page.getByTestId(`diff-status-${PATH}`)).toHaveText("R");
		await expect(page.getByTestId(`diff-pane-${PATH}`)).toContainText(
			`Diff · src/old.ts → ${PATH}`,
		);
	});

	test("an unresolved conflict says where the markers are", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		await openDiffTab(page, student, "Conflict", {
			[PATH]: diff({ status: "U", after: "<<<<<<< HEAD\nmine\n=======\ntheirs\n" }),
		});

		await expect(page.getByTestId(`diff-status-${PATH}`)).toHaveText("!");
		await expect(page.getByTestId("diff-note")).toHaveText(
			"Unresolved merge conflict; the working-tree side shows the conflict markers",
		);
	});

	test("a binary change offers a download instead of a diff", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const binaryPath = "assets/logo.png";
		await openDiffTab(
			page,
			student,
			"Binary",
			{ [binaryPath]: diff({ before: null, after: null, binary: true }) },
			binaryPath,
		);

		await expect(page.getByText("Binary file changed")).toBeVisible();
		await expect(
			page.getByRole("button", { name: "Download logo.png" }),
		).toHaveAttribute("data-testid", `diff-download-${binaryPath}`);
		await expect(page.getByTestId(`diff-editor-${binaryPath}`)).toHaveCount(0);
	});

	test("a diff past the limit explains it and offers the file", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		await openDiffTab(page, student, "Too large", {
			[PATH]: diff({ before: null, after: null, tooLarge: true }),
		});

		await expect(page.getByText("This diff is too large to show here")).toBeVisible();
		await expect(page.getByTestId(`diff-download-${PATH}`)).toBeVisible();
		// Edit turns the same tab back into the editor.
		await page.getByTestId(`file-view-edit-${PATH}`).click();
		await expect(page.getByTestId(`file-pane-${PATH}`)).toBeVisible({
			timeout: 30_000,
		});
	});

	test("coming back to the window refreshes the diff without a reload", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const project = await openDiffTab(page, student, "Refresh", { [PATH]: diff() });
		const editor = page.getByTestId(`diff-editor-${PATH}`);
		await expect(editor).toContainText("const answer = 42;", { timeout: 60_000 });

		// What a coding agent or a shell command would do.
		await seedGit(student.workspaceId, project.slug, {
			diffs: { [PATH]: diff({ after: "const answer = 43; // changed\n" }) },
		});
		// Coming back to the window is what asks for the diff again.
		await page.evaluate(() => window.dispatchEvent(new Event("visibilitychange")));

		await expect(editor).toContainText("// changed", { timeout: 20_000 });
	});

	test("coming back to the diff tab refreshes it", async ({ page, context }) => {
		const student = await createStudent(context);
		const project = await openDiffTab(page, student, "Return", { [PATH]: diff() });
		const editor = page.getByTestId(`diff-editor-${PATH}`);
		await expect(editor).toContainText("const answer = 42;", { timeout: 60_000 });

		// A new terminal tab puts the diff in the background, which stops it
		// asking for the diff at all.
		await newTerminal(page);
		await expect(page.getByTestId(`diff-pane-${PATH}`)).toBeHidden();

		await seedGit(student.workspaceId, project.slug, {
			diffs: { [PATH]: diff({ after: "const answer = 44; // while away\n" }) },
		});

		await page.getByTestId(`tab-file:${PATH}`).click();
		await expect(editor).toContainText("// while away", { timeout: 20_000 });
	});

	test("clicking an open file in the Changes list uses its own tab", async ({
		page,
		context,
	}) => {
		// Issue #160: the diff is a view of the file's tab, so the same file
		// never appears twice in the strip.
		const student = await createStudent(context);
		const project = await createProject(student.workspaceId, { name: "One tab" });
		await seedFile(student.workspaceId, project.slug, PATH, "const answer = 42;\n");
		await seedGit(student.workspaceId, project.slug, {
			status: {
				repo: true,
				branch: "main",
				detached: false,
				upstream: "origin/main",
				ahead: 0,
				behind: 0,
				conflicts: 0,
				entries: [{ path: PATH, x: ".", y: "M", unmerged: false }],
				ignored: [],
				truncated: false,
			},
			diffs: { [PATH]: diff() },
		});
		await query("update projects set layout = $2 where id = $1", [
			project.id,
			JSON.stringify({
				tabs: [{ id: `file:${PATH}`, root: { type: "file", path: PATH } }],
			}),
		]);
		await page.goto(workspacePath(student.workspaceId, project.id));
		await expect(page.getByTestId(`file-pane-${PATH}`)).toBeVisible({
			timeout: 15_000,
		});

		await page.getByTestId(`change-row-${PATH}`).click();

		// One tab, showing the diff.
		await expect(workTabs(page)).toHaveCount(1);
		await expect(page.getByTestId(`diff-pane-${PATH}`)).toBeVisible({
			timeout: 15_000,
		});
		await expect(page.getByTestId(`file-pane-${PATH}`)).toBeHidden();

		// And the toggle goes back to the editor, still in the one tab.
		await page.getByTestId(`file-view-edit-${PATH}`).click();
		await expect(page.getByTestId(`file-pane-${PATH}`)).toBeVisible();
		await expect(page.getByTestId(`diff-pane-${PATH}`)).toHaveCount(0);
		await expect(workTabs(page)).toHaveCount(1);

		// Opening the file from the tree also takes a tab that is showing its
		// diff back to the editor, rather than leaving the diff up.
		await page.getByTestId(`change-row-${PATH}`).click();
		await expect(page.getByTestId(`diff-pane-${PATH}`)).toBeVisible();
		await page.getByTestId("file-row-src").click();
		await page.getByTestId(`file-row-${PATH}`).click();
		await expect(page.getByTestId(`file-pane-${PATH}`)).toBeVisible();
		await expect(page.getByTestId(`diff-pane-${PATH}`)).toHaveCount(0);
		await expect(workTabs(page)).toHaveCount(1);
	});
});
