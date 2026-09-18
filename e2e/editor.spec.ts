import { expect, type Page, test } from "@playwright/test";
import {
	createProject,
	createStudent,
	query,
	readSeededFile,
	seedFile,
	type TestProject,
	type TestStudent,
	workspacePath,
} from "./helpers";

/**
 * The file editor: autosave, external refresh, conflicts and the viewer for
 * files that cannot be edited (SPEC.md §13.1, §13.2, §13.3, §13.5).
 */
test.describe("file editor", () => {
	// Monaco is a large chunk the dev server transforms on first use, so the
	// first run of this file is much slower than the rest of the suite.
	test.describe.configure({ timeout: 90_000 });

	const PATH = "src/app.ts";

	/** Open a project whose saved layout already has one file tab. */
	async function openFileTab(
		page: Page,
		student: TestStudent,
		name: string,
		path = PATH,
		content = "const answer = 42;\n",
	): Promise<TestProject> {
		const project = await createProject(student.workspaceId, { name });
		await seedFile(student.workspaceId, project.slug, path, content);
		await query("update projects set layout = $2 where id = $1", [
			project.id,
			JSON.stringify({
				tabs: [{ id: `file:${path}`, root: { type: "file", path } }],
			}),
		]);
		await page.goto(workspacePath(student.workspaceId, project.id));
		await expect(page.getByTestId(`file-pane-${path}`)).toBeVisible({
			timeout: 15_000,
		});
		return project;
	}

	function status(page: Page, path = PATH) {
		return page.getByTestId(`file-status-${path}`);
	}

	/** Monaco paints the text into `.view-lines`. */
	function lines(page: Page, path = PATH) {
		return page.getByTestId(`editor-${path}`).locator(".view-lines");
	}

	test("a file opens in the editor and typing autosaves it", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const project = await openFileTab(page, student, "Editing");

		await expect(lines(page)).toContainText("const answer = 42;", {
			timeout: 60_000,
		});
		await expect(status(page)).toHaveText("Saved");

		await lines(page).click();
		await page.keyboard.press("End");
		await page.keyboard.type(" // hello");
		// The pill goes through Unsaved while the debounce runs, then Saved.
		await expect(status(page)).toHaveText("Unsaved");
		await expect(lines(page)).toContainText("// hello");
		await expect(status(page)).toHaveText("Saved", { timeout: 15_000 });
		await expect
			.poll(async () => readSeededFile(student.workspaceId, project.slug, PATH), {
				timeout: 15_000,
			})
			.toContain("// hello");
	});

	test("a change on disk refreshes an editor with no local edits", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const project = await openFileTab(page, student, "Refresh");
		await expect(lines(page)).toContainText("const answer = 42;", {
			timeout: 60_000,
		});

		// What a coding agent or a shell command would do.
		await seedFile(
			student.workspaceId,
			project.slug,
			PATH,
			"const answer = 7; // from the agent\n",
		);
		await expect(lines(page)).toContainText("from the agent", { timeout: 20_000 });
		await expect(status(page)).toHaveText("Saved");
	});

	test("a change on disk while editing is a conflict the student resolves", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const project = await openFileTab(page, student, "Conflict");
		await expect(lines(page)).toContainText("const answer = 42;", {
			timeout: 60_000,
		});

		await lines(page).click();
		await page.keyboard.press("End");
		await page.keyboard.type(" // mine");
		await seedFile(
			student.workspaceId,
			project.slug,
			PATH,
			"const answer = 7; // theirs\n",
		);

		await expect(page.getByTestId("file-conflict")).toBeVisible({ timeout: 20_000 });
		await expect(status(page)).toHaveText("Conflict");

		await page.getByTestId("take-theirs").click();
		await expect(lines(page)).toContainText("// theirs");
		await expect(page.getByTestId("file-conflict")).toHaveCount(0);
		await expect(status(page)).toHaveText("Saved");
	});

	test("Keep mine writes the local text over the file on disk", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const project = await openFileTab(page, student, "Keep mine");
		await expect(lines(page)).toContainText("const answer = 42;", {
			timeout: 60_000,
		});

		await lines(page).click();
		await page.keyboard.press("End");
		await page.keyboard.type(" // mine");
		await seedFile(
			student.workspaceId,
			project.slug,
			PATH,
			"const answer = 7; // theirs\n",
		);
		await expect(page.getByTestId("file-conflict")).toBeVisible({ timeout: 20_000 });

		await page.getByTestId("keep-mine").click();
		await expect(status(page)).toHaveText("Saved", { timeout: 15_000 });
		await expect
			.poll(async () => readSeededFile(student.workspaceId, project.slug, PATH), {
				timeout: 15_000,
			})
			.toContain("// mine");
	});

	test("a binary file offers a download instead of the editor", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const path = "assets/logo.png";
		await openFileTab(page, student, "Binary", path, "\u0000\u0001PNG\u0000");

		await expect(page.getByTestId("file-download")).toBeVisible({ timeout: 15_000 });
		await expect(page.getByTestId(`editor-${path}`)).toHaveCount(0);
		await expect(page.getByTestId("file-download")).toHaveAttribute(
			"href",
			/download=1/,
		);
	});
});
