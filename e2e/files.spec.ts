import { expect, type Page, test } from "@playwright/test";
import {
	createProject,
	createStudent,
	query,
	readSeededFile,
	seedFile,
	type TestProject,
	toast,
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

	/** SPEC.md §11.2: an empty project can still get its first file. */
	test("creating the first file in an empty project from the header menu", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const project = await createProject(student.workspaceId, { name: "Empty" });
		await page.goto(workspacePath(student.workspaceId, project.id));
		await expect(page.getByText("No files yet")).toBeVisible({ timeout: 15_000 });

		await page.getByTestId("files-more").click();
		await page.getByTestId("files-more-new-file").click();
		await page.getByTestId("field-file-name").fill("first.txt");
		await page.getByTestId("dialog-confirm").click();

		await expect(row(page, "first.txt")).toBeVisible();
		expect(await readSeededFile(student.workspaceId, project.slug, "first.txt")).toBe(
			"",
		);
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
		// The saved layout arrives after the tree; clicking before it lands
		// would open the file instead of refusing it.
		await expect(page.getByTestId("tab-file:full-15.txt")).toBeVisible();

		await row(page, "README.md").click();

		const refused = toast(page, "Too many tabs are open. Close one to open another.");
		await expect(refused).toBeVisible();
		// One click refuses once: a second toast would mean a doubled handler.
		await expect(refused).toHaveCount(1);
		await expect(page.getByTestId("tab-file:README.md")).toHaveCount(0);
	});

	test("dragging a file onto the project root moves it there", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const project = await openProject(page, student.workspaceId, "Dragging");

		await row(page, "src").click();
		await expect(row(page, "src/app.ts")).toBeVisible();

		// The pointer sensor needs a few pixels of movement before it starts.
		const source = await row(page, "src/app.ts").boundingBox();
		const target = await page.getByTestId("file-tree-root-drop").boundingBox();
		if (!source || !target) throw new Error("the drag needs both boxes");
		await page.mouse.move(source.x + 20, source.y + source.height / 2);
		await page.mouse.down();
		await page.mouse.move(source.x + 30, source.y + source.height / 2, { steps: 5 });
		await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, {
			steps: 10,
		});
		await page.mouse.up();

		await expect(row(page, "app.ts")).toBeVisible();
		await expect(row(page, "src/app.ts")).toHaveCount(0);
		expect(await readSeededFile(student.workspaceId, project.slug, "app.ts")).toBe(
			"export const a = 1;\n",
		);
	});

	test("an upload onto an existing name says so and offers to replace", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const project = await openProject(page, student.workspaceId, "Clashing");

		await page.getByTestId("files-upload-input").setInputFiles({
			name: "README.md",
			mimeType: "text/plain",
			buffer: Buffer.from("# replaced\n"),
		});

		await expect(
			toast(page, "Something with that name already exists here"),
		).toBeVisible();
		expect(await readSeededFile(student.workspaceId, project.slug, "README.md")).toBe(
			"# hello\n",
		);

		await page.getByTestId("upload-replace").click();

		await expect
			.poll(async () => readSeededFile(student.workspaceId, project.slug, "README.md"))
			.toBe("# replaced\n");
	});

	/** SPEC.md §11.2, issue #182: several rows at once. */
	test("Shift-click selects a run of files and deletes them together", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const project = await openProject(page, student.workspaceId, "Selecting");
		await seedFile(student.workspaceId, project.slug, "a.txt", "a\n");
		await seedFile(student.workspaceId, project.slug, "b.txt", "b\n");
		await seedFile(student.workspaceId, project.slug, "c.txt", "c\n");
		await expect(row(page, "c.txt")).toBeVisible({ timeout: 15_000 });

		await row(page, "a.txt").click();
		await row(page, "c.txt").click({ modifiers: ["Shift"] });

		for (const name of ["a.txt", "b.txt", "c.txt"]) {
			await expect(row(page, name)).toHaveAttribute("data-selected", "true");
		}

		await page.getByTestId("file-menu-b.txt").click();
		await page.getByTestId("row-delete").click();

		const dialog = page.getByTestId("dialog-delete-file");
		await expect(dialog).toContainText("Delete 3 items");
		await expect(dialog).toContainText("a.txt, b.txt, c.txt");
		await page.getByTestId("dialog-confirm").click();

		for (const name of ["a.txt", "b.txt", "c.txt"]) {
			await expect(row(page, name)).toHaveCount(0);
		}
		// The rest of the project is untouched.
		await expect(row(page, "README.md")).toBeVisible();
	});

	/** Issue #185: the icon says what kind of file the row holds. */
	test("a markdown file and a TypeScript file get different icons", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		await openProject(page, student.workspaceId, "Icons");
		await row(page, "src").click();
		await expect(row(page, "src/app.ts")).toBeVisible();

		await expect(
			row(page, "README.md").locator("[data-icon^=file]").first(),
		).toHaveAttribute("data-icon", "file-markdown");
		await expect(
			row(page, "src/app.ts").locator("[data-icon^=file]").first(),
		).toHaveAttribute("data-icon", "file-code");
	});

	/** Issue #183: an upload dragged over the pane says where it will land. */
	test("dragging a file over the pane highlights the project root", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		await openProject(page, student.workspaceId, "Dropping");

		const body = page.getByTestId("file-tree-body");
		await expect(body).not.toHaveAttribute("data-upload-root", "true");

		const transfer = await page.evaluateHandle(() => {
			const data = new DataTransfer();
			data.items.add(new File(["hello"], "dropped.txt", { type: "text/plain" }));
			return data;
		});
		await body.dispatchEvent("dragenter", { dataTransfer: transfer });

		await expect(body).toHaveAttribute("data-upload-root", "true");
		await expect(page.getByTestId("file-tree-root-hint")).toContainText(
			"Drop to upload to Dropping",
		);
	});

	/** Issue #186: the name field is ready to type into. */
	test("the New file dialog takes typing straight away", async ({ page, context }) => {
		const student = await createStudent(context);
		await openProject(page, student.workspaceId, "Typing");

		await page.getByTestId("files-new").click();
		await page.getByTestId("files-new-file").click();
		await expect(page.getByTestId("field-file-name")).toBeFocused();

		await page.keyboard.type("straight.txt");
		await expect(page.getByTestId("field-file-name")).toHaveValue("straight.txt");

		await page.getByTestId("dialog-confirm").click();
		await expect(row(page, "straight.txt")).toBeVisible();
	});

	test("deleting a directory says what goes with it", async ({ page, context }) => {
		const student = await createStudent(context);
		await openProject(page, student.workspaceId, "Deleting");

		await page.getByTestId("file-menu-src").click();
		await page.getByTestId("row-delete").click();

		await expect(page.getByTestId("dialog-delete-file")).toContainText(
			"src and everything inside it is removed. This cannot be undone.",
		);

		await page.getByTestId("dialog-confirm").click();
		await expect(row(page, "src")).toHaveCount(0);
	});
});
