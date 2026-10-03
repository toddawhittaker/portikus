import { expect, type Page, test } from "@playwright/test";
import {
	createProject,
	createStudent,
	expectNoViolations,
	readSeededFile,
	seedFile,
	type TestProject,
	workspacePath,
} from "./helpers";

/**
 * The file tree and the project list from the keyboard alone (SPEC.md §25.8).
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

	/** The APG tree view keys: Home, End and type-ahead (SPEC.md §25.8). */
	test("jumps with Home, End and typed letters", async ({ page, context }) => {
		const student = await createStudent(context);
		await openProject(page, student.workspaceId, "Keys Jump");
		await expect(page.getByRole("tree")).toHaveAttribute(
			"aria-multiselectable",
			"true",
		);
		const rows = page.getByRole("treeitem");
		await expect(rows).toHaveCount(3);

		await rows.first().focus();
		await page.keyboard.press("End");
		await expect(rows.last()).toBeFocused();
		await expect(rows.last()).toHaveAttribute("aria-selected", "true");
		await page.keyboard.press("Home");
		await expect(rows.first()).toBeFocused();
		await expect(rows.last()).toHaveAttribute("aria-selected", "false");

		await page.keyboard.type("re");
		await expect(row(page, "README.md")).toBeFocused();
		// After a pause the typed text starts again (TYPE_AHEAD_RESET_MS).
		await page.waitForTimeout(700);
		await page.keyboard.type(".");
		await expect(row(page, ".env")).toBeFocused();
	});

	/** Shift+Arrow and Ctrl+Space build the selection a row menu acts on. */
	test("builds a selection from the keyboard and acts on all of it", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		await openProject(page, student.workspaceId, "Keys Select");
		const rows = page.getByRole("treeitem");
		await expect(rows).toHaveCount(3);

		await rows.nth(0).focus();
		await page.keyboard.press("Shift+ArrowDown");
		await expect(rows.nth(1)).toBeFocused();
		await expect(rows.nth(0)).toHaveAttribute("aria-selected", "true");
		await expect(rows.nth(1)).toHaveAttribute("aria-selected", "true");

		// Ctrl+Arrow moves alone; Ctrl+Space then adds the row it reached.
		await page.keyboard.press("Control+ArrowDown");
		await expect(rows.nth(2)).toBeFocused();
		await expect(rows.nth(2)).toHaveAttribute("aria-selected", "false");
		await page.keyboard.press("Control+Space");
		await expect(rows.nth(2)).toHaveAttribute("aria-selected", "true");

		await page.keyboard.press("Shift+F10");
		await expect(page.getByTestId("row-delete")).toHaveText("Delete 3 items…");
		await page.keyboard.press("Escape");

		// Ctrl+Space again takes it back out.
		await expect(rows.nth(2)).toBeFocused();
		await page.keyboard.press("Control+Space");
		await expect(rows.nth(2)).toHaveAttribute("aria-selected", "false");
		await expect(rows.nth(1)).toHaveAttribute("aria-selected", "true");
	});

	for (const theme of ["light", "dark"] as const) {
		test(`the tree with a keyboard selection passes axe in the ${theme} theme`, async ({
			page,
			context,
		}) => {
			await context.addInitScript((value) => {
				localStorage.setItem("pk-theme", value);
			}, theme);
			const student = await createStudent(context);
			await openProject(page, student.workspaceId, `Keys Axe ${theme}`);
			await expect(page.locator("html")).toHaveAttribute("data-theme", theme);

			const rows = page.getByRole("treeitem");
			await rows.first().focus();
			await page.keyboard.press("Shift+ArrowDown");
			await expect(rows.nth(1)).toHaveAttribute("aria-selected", "true");

			await expectNoViolations(page, '[data-testid="file-tree"]');
		});
	}
});
