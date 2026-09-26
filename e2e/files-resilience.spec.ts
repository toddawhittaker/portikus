import { expect, type Page, test } from "@playwright/test";
import {
	createProject,
	createStudent,
	openFileTab,
	pushEvent,
	seedFile,
	toast,
	workspacePath,
} from "./helpers";
import { FAKE_AGENT_URL } from "./ports";

/**
 * A full home folder and a project too large to watch (SPEC.md §11.4,
 * §13.5, §28; issues #621 and #622).
 */
test.describe("file resilience", () => {
	test.describe.configure({ timeout: 90_000 });

	/** Make every write in this workspace fail as the disk being full. */
	async function setDiskFull(workspaceId: string, full: boolean): Promise<void> {
		const response = await fetch(`${FAKE_AGENT_URL}/__test/disk-full`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ key: workspaceId, full }),
		});
		expect(response.ok).toBe(true);
	}

	function row(page: Page, path: string) {
		return page.getByTestId(`file-row-${path}`);
	}

	test("a save on a full disk says to delete files and save again", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const path = "notes.txt";
		await openFileTab(page, student, "Full save", path, "hello\n");
		const lines = page.getByTestId(`editor-${path}`).locator(".view-lines");
		await expect(lines).toContainText("hello", { timeout: 60_000 });
		await setDiskFull(student.workspaceId, true);

		await lines.click();
		await page.keyboard.press("End");
		await page.keyboard.type(" more");
		await expect(page.getByTestId(`file-status-${path}`)).toHaveText("Save failed", {
			timeout: 15_000,
		});
		await expect(
			page.getByText("Your home folder is full. Delete files, then save again."),
		).toBeVisible();
	});

	test("a new folder on a full disk says to delete files and try again", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const project = await createProject(student.workspaceId, { name: "Full folder" });
		await seedFile(student.workspaceId, project.slug, "README.md", "# hi\n");
		await page.goto(workspacePath(student.workspaceId, project.id));
		await expect(row(page, "README.md")).toBeVisible({ timeout: 15_000 });
		await setDiskFull(student.workspaceId, true);

		await page.getByTestId("files-new").click();
		await page.getByTestId("files-new-folder").click();
		await page.getByTestId("field-file-name").fill("more");
		await page.getByTestId("dialog-confirm").click();

		await expect(
			toast(page, "Your home folder is full. Delete files, then try again."),
		).toBeVisible();
		await expect(row(page, "more")).toHaveCount(0);
	});

	test("a new project on a full disk says to delete files and try again", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		await page.goto(workspacePath(student.workspaceId));
		await expect(page.getByTestId("empty-projects")).toBeVisible({ timeout: 15_000 });
		await setDiskFull(student.workspaceId, true);

		await page.getByTestId("new-project").click();
		await page.getByRole("menuitem", { name: "New project" }).click();
		await page.getByTestId("field-name").fill("Too Much");
		await page.getByTestId("dialog-confirm").click();

		await expect(page.getByTestId("dialog-error")).toContainText(
			"Your home folder is full. Delete files, then try again.",
		);
	});

	test("a project too large to watch says so once and refreshes on focus", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const project = await createProject(student.workspaceId, { name: "Huge" });
		await seedFile(student.workspaceId, project.slug, "README.md", "# hi\n");
		await page.goto(workspacePath(student.workspaceId, project.id));
		await expect(row(page, "README.md")).toBeVisible({ timeout: 15_000 });

		await expect
			.poll(() =>
				pushEvent(student.workspaceId, project.slug, { type: "watch_limited" }),
			)
			.toBe(1);
		const notice = page.getByTestId("files-watch-limited");
		await expect(notice).toHaveText(
			"This project is too large to update live. It refreshes when you return to the window.",
		);

		// The socket is closed and not reopened, so a change on disk waits for focus.
		await seedFile(student.workspaceId, project.slug, "later.txt", "x\n");
		await page.waitForTimeout(1_500);
		await expect(row(page, "later.txt")).toHaveCount(0);
		await page.evaluate(() => window.dispatchEvent(new Event("focus")));
		await expect(row(page, "later.txt")).toBeVisible();
		await expect(notice).toHaveCount(1);
	});
});
