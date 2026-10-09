import { expect, test } from "@playwright/test";
import {
	createProject,
	createStudent,
	readSeededFile,
	seedFile,
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
});
