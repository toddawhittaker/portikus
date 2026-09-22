import { expect, type Page, test } from "@playwright/test";
import {
	createProject,
	createStudent,
	readSeededFile,
	seedFile,
	type TestProject,
	workspacePath,
} from "./helpers";

/**
 * The file tree and the project list from the keyboard alone (SPEC.md §25.8,
 * issues #361, #366, #370).
 */
test.describe("file tree accessibility", () => {
	async function openProject(
		page: Page,
		workspaceId: string,
		name: string,
	): Promise<TestProject> {
		const project = await createProject(workspaceId, { name });
		await seedFile(workspaceId, project.slug, "src/app.ts", "export const a = 1;\n");
		await seedFile(workspaceId, project.slug, "README.md", "# hello\n");
		await seedFile(workspaceId, project.slug, ".env", "SECRET=1\n");
		await page.goto(workspacePath(workspaceId, project.id));
		await expect(page.getByTestId("file-tree")).toBeVisible({ timeout: 15_000 });
		return project;
	}

	function row(page: Page, path: string) {
		return page.getByTestId(`file-row-${path}`);
	}

	test("downloads a project zip from the keyboard", async ({ page, context }) => {
		const student = await createStudent(context);
		const project = await openProject(page, student.workspaceId, "Keys Zip");

		await page.getByTestId(`project-menu-${project.id}`).focus();
		await page.keyboard.press("Enter");
		const item = page.getByRole("menuitem", { name: "Download as zip" });
		await expect(item).toBeVisible();
		const downloadPromise = page.waitForEvent("download");
		await item.focus();
		await page.keyboard.press("Enter");
		const download = await downloadPromise;

		expect(download.suggestedFilename()).toBe(`${project.slug}.zip`);
	});

	test("turns Show hidden off from the keyboard", async ({ page, context }) => {
		const student = await createStudent(context);
		await openProject(page, student.workspaceId, "Keys Hidden");
		await expect(row(page, ".env")).toBeVisible();

		await page.getByTestId("files-more").focus();
		await page.keyboard.press("Enter");
		const item = page.getByRole("menuitemcheckbox", {
			name: "Show hidden and generated files",
		});
		await expect(item).toHaveAttribute("aria-checked", "true");
		await item.focus();
		await page.keyboard.press("Enter");

		await expect(row(page, ".env")).toHaveCount(0);
	});

	test("opens a row's menu with Shift+F10 and returns to the row", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		await openProject(page, student.workspaceId, "Keys Menu");

		await row(page, "README.md").focus();
		await page.keyboard.press("Shift+F10");
		await expect(
			page.getByRole("menu", { name: "Actions for README.md" }),
		).toBeVisible();

		await page.keyboard.press("Escape");
		await expect(page.getByRole("menu")).toHaveCount(0);
		await expect(row(page, "README.md")).toBeFocused();
	});

	test("one Tab leaves the tree", async ({ page, context }) => {
		const student = await createStudent(context);
		await openProject(page, student.workspaceId, "Keys Tab");

		await row(page, "src").focus();
		await page.keyboard.press("Tab");

		const inTree = await page.evaluate(
			() => document.activeElement?.closest("[data-testid=file-tree]") !== null,
		);
		expect(inTree).toBe(false);
	});

	test("moves a file into a folder with Move to…", async ({ page, context }) => {
		const student = await createStudent(context);
		const project = await openProject(page, student.workspaceId, "Keys Move");

		await row(page, "README.md").focus();
		await page.keyboard.press("Shift+F10");
		await page.getByTestId("row-move").click();
		const dialog = page.getByTestId("dialog-move-file");
		await dialog.getByTestId("move-folder-src").click();
		await expect(dialog.getByTestId("move-destination")).toContainText("/src");
		await dialog.getByTestId("dialog-confirm").click();

		await expect(dialog).toHaveCount(0);
		await expect(row(page, "src/README.md")).toBeVisible();
		await expect(row(page, "README.md")).toHaveCount(0);
		expect(
			await readSeededFile(student.workspaceId, project.slug, "src/README.md"),
		).toBe("# hello\n");
	});
});
