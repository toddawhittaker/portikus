import { expect, type Page, test } from "@playwright/test";
import {
	createProject,
	createStudent,
	query,
	readSeededFile,
	seedFile,
	type TestProject,
	workspacePath,
} from "./helpers";

/**
 * The file tree pane: listing, hidden and generated files, create, rename,
 * delete, upload, download and opening a file as a tab (SPEC.md §8.4,
 * §11.2, §11.3).
 */
test.describe("file tree", () => {
	/** Seed a project with a small tree and open it. */
	async function openProject(
		page: Page,
		workspaceId: string,
		name: string,
	): Promise<TestProject> {
		const project = await createProject(workspaceId, { name });
		await seedFile(workspaceId, project.slug, "src/app.ts", "export const a = 1;\n");
		await seedFile(workspaceId, project.slug, "README.md", "# hello\n");
		await seedFile(workspaceId, project.slug, ".env", "SECRET=1\n");
		await seedFile(workspaceId, project.slug, "node_modules/x/index.js", "module\n");
		await page.goto(workspacePath(workspaceId, project.id));
		await expect(page.getByTestId("file-tree")).toBeVisible({ timeout: 15_000 });
		return project;
	}

	function row(page: Page, path: string) {
		return page.getByTestId(`file-row-${path}`);
	}

	test("hides generated and dotted names until Show hidden is on", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		await openProject(page, student.workspaceId, "Hidden");

		await expect(row(page, "src")).toBeVisible();
		await expect(row(page, "README.md")).toBeVisible();
		await expect(row(page, ".env")).toHaveCount(0);
		await expect(row(page, "node_modules")).toHaveCount(0);

		await page.getByTestId("files-more").click();
		await page.getByText("Show hidden and generated files").click();
		await page.keyboard.press("Escape");

		// Hiding is only a view filter (SPEC.md §11.3).
		await expect(row(page, ".env")).toBeVisible();
		await expect(row(page, "node_modules")).toBeVisible();
	});

	test("expanding a directory and clicking a file opens a file tab", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		await openProject(page, student.workspaceId, "Opening");

		await expect(row(page, "src/app.ts")).toHaveCount(0);
		await row(page, "src").click();
		await expect(row(page, "src/app.ts")).toBeVisible();

		await row(page, "src/app.ts").click();

		const tab = page.getByTestId("tab-file:src/app.ts");
		await expect(tab).toBeVisible();
		await expect(tab).toContainText("app.ts");
		await expect(page.getByTestId("file-pane-src/app.ts")).toBeVisible();
	});

	test("creating, renaming and deleting a file from the pane", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const project = await openProject(page, student.workspaceId, "Editing");

		await page.getByTestId("files-new").click();
		await page.getByTestId("files-new-file").click();
		await page.getByTestId("field-file-name").fill("notes.txt");
		await page.getByTestId("dialog-confirm").click();

		await expect(row(page, "notes.txt")).toBeVisible();
		expect(await readSeededFile(student.workspaceId, project.slug, "notes.txt")).toBe(
			"",
		);

		await page.getByTestId("file-menu-notes.txt").click();
		await page.getByTestId("row-rename").click();
		await page.getByTestId("field-file-name").fill("todo.txt");
		await page.getByTestId("dialog-confirm").click();

		await expect(row(page, "todo.txt")).toBeVisible();
		await expect(row(page, "notes.txt")).toHaveCount(0);

		await page.getByTestId("file-menu-todo.txt").click();
		await page.getByTestId("row-delete").click();
		await expect(page.getByTestId("dialog-delete-file")).toBeVisible();
		await page.getByTestId("dialog-confirm").click();

		await expect(row(page, "todo.txt")).toHaveCount(0);
	});

	test("creating a folder from the pane header", async ({ page, context }) => {
		const student = await createStudent(context);
		await openProject(page, student.workspaceId, "Folders");

		await page.getByTestId("files-new").click();
		await page.getByTestId("files-new-folder").click();
		await page.getByTestId("field-file-name").fill("docs");
		await page.getByTestId("dialog-confirm").click();

		await expect(row(page, "docs")).toBeVisible();
	});

	test("uploading a file puts it in the tree with its contents", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const project = await openProject(page, student.workspaceId, "Uploads");

		await page.getByTestId("files-upload-input").setInputFiles({
			name: "upload.txt",
			mimeType: "text/plain",
			buffer: Buffer.from("uploaded bytes\n"),
		});

		await expect(row(page, "upload.txt")).toBeVisible();
		expect(await readSeededFile(student.workspaceId, project.slug, "upload.txt")).toBe(
			"uploaded bytes\n",
		);
	});

	test("a file's download link points at the download route", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const project = await openProject(page, student.workspaceId, "Downloads");

		await page.getByTestId("file-menu-README.md").click();

		await expect(page.getByTestId("row-download-README.md")).toHaveAttribute(
			"href",
			`/workspaces/${student.workspaceId}/projects/${project.id}/file?path=README.md&download=1`,
		);
	});

	test("a full tab strip says to close a tab first", async ({ page, context }) => {
		const student = await createStudent(context);
		const project = await createProject(student.workspaceId, { name: "Full" });
		await seedFile(student.workspaceId, project.slug, "README.md", "# hello\n");
		// Sixteen tabs is the cap (SPEC.md §7.5, MAX_LAYOUT_TABS).
		const tabs = Array.from({ length: 16 }, (_item, index) => ({
			id: `file:full-${index}.txt`,
			root: { type: "file", path: `full-${index}.txt` },
		}));
		await query("update projects set layout = $2 where id = $1", [
			project.id,
			JSON.stringify({ tabs }),
		]);

		await page.goto(workspacePath(student.workspaceId, project.id));
		await expect(page.getByTestId("file-tree")).toBeVisible({ timeout: 15_000 });

		await row(page, "README.md").click();

		await expect(
			page.getByText("Too many tabs are open. Close one to open another."),
		).toBeVisible();
		await expect(page.getByTestId("tab-file:README.md")).toHaveCount(0);
	});
});
