import { expect, test } from "@playwright/test";
import {
	createProject,
	createStudent,
	readSeededFile,
	seedFile,
	settledAxe,
	WCAG_TAGS,
	workspacePath,
} from "./helpers";

/** A rename onto a taken file name asks before replacing it (SPEC.md §11.2). */
test.describe("replacing a file by rename", () => {
	test("asks, keeps the file on cancel, and replaces it on confirm", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const project = await createProject(student.workspaceId, { name: "Replace" });
		await seedFile(student.workspaceId, project.slug, "draft.md", "new\n");
		await seedFile(student.workspaceId, project.slug, "notes.md", "old\n");
		await page.goto(workspacePath(student.workspaceId, project.id));
		await expect(page.getByTestId("file-tree")).toBeVisible({ timeout: 15_000 });

		async function renameDraft() {
			await page.getByTestId("file-menu-draft.md").click();
			await page.getByTestId("row-rename").click();
			await page.getByTestId("field-file-name").fill("notes.md");
			await page.getByTestId("dialog-confirm").click();
		}

		const confirm = page.getByTestId("dialog-replace-file");
		await renameDraft();
		await expect(confirm).toContainText("Replace notes.md?");
		await confirm.getByRole("button", { name: "Cancel" }).click();
		await expect(confirm).toHaveCount(0);
		await page.keyboard.press("Escape");
		expect(await readSeededFile(student.workspaceId, project.slug, "notes.md")).toBe(
			"old\n",
		);

		await renameDraft();
		await confirm.getByTestId("dialog-confirm").click();
		await expect(page.getByTestId("file-row-draft.md")).toHaveCount(0);
		await expect(page.getByTestId("file-row-notes.md")).toBeVisible();
		expect(await readSeededFile(student.workspaceId, project.slug, "notes.md")).toBe(
			"new\n",
		);
	});

	/** SPEC.md §25.8: the prompt passes axe, and Escape returns to the rename dialog. */
	test("the prompt is accessible and Escape goes back to the rename", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const project = await createProject(student.workspaceId, { name: "Keys" });
		await seedFile(student.workspaceId, project.slug, "draft.md", "new\n");
		await seedFile(student.workspaceId, project.slug, "notes.md", "old\n");
		await page.goto(workspacePath(student.workspaceId, project.id));
		await expect(page.getByTestId("file-tree")).toBeVisible({ timeout: 15_000 });

		// Keyboard only: focus the row, open its menu, rename, submit.
		await page.getByTestId("file-row-draft.md").focus();
		await page.keyboard.press("Shift+F10");
		const renameItem = page.getByRole("menuitem", { name: "Rename…" });
		await expect(renameItem).toBeVisible();
		await renameItem.focus();
		await page.keyboard.press("Enter");
		const field = page.getByTestId("field-file-name");
		await expect(field).toBeFocused();
		await page.keyboard.press("ControlOrMeta+a");
		await page.keyboard.type("notes.md");
		await page.keyboard.press("Enter");

		const confirm = page.getByTestId("dialog-replace-file");
		await expect(confirm).toContainText("Replace notes.md?");
		const results = await (await settledAxe(page))
			.withTags(WCAG_TAGS)
			.include("[data-testid=dialog-replace-file]")
			.analyze();
		expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);

		await page.keyboard.press("Escape");
		await expect(confirm).toHaveCount(0);
		const rename = page.getByTestId("dialog-file-name");
		await expect(rename).toBeVisible();
		const focusInRename = await rename.evaluate((dialog) =>
			dialog.contains(document.activeElement),
		);
		expect(focusInRename).toBe(true);
		expect(await readSeededFile(student.workspaceId, project.slug, "notes.md")).toBe(
			"old\n",
		);
	});

	/** SPEC.md §11.2: only a file replaces a file, so a folder in the way is not offered. */
	test("a file renamed onto a folder's name fails without a prompt", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const project = await createProject(student.workspaceId, { name: "Folder" });
		await seedFile(student.workspaceId, project.slug, "draft.md", "new\n");
		await seedFile(student.workspaceId, project.slug, "docs/keep.md", "keep\n");
		await page.goto(workspacePath(student.workspaceId, project.id));
		await expect(page.getByTestId("file-tree")).toBeVisible({ timeout: 15_000 });

		await page.getByTestId("file-menu-draft.md").click();
		await page.getByTestId("row-rename").click();
		await page.getByTestId("field-file-name").fill("docs");
		await page.getByTestId("dialog-confirm").click();

		await expect(
			page.getByText("Something with that name already exists here", { exact: true }),
		).toBeVisible();
		await expect(page.getByTestId("dialog-replace-file")).toHaveCount(0);
		await expect(page.getByTestId("file-row-draft.md")).toBeVisible();
	});
});
