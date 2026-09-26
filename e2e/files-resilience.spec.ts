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
		// Count this project's events sockets, and note when each one closes.
		const sockets: { closed: boolean }[] = [];
		page.on("websocket", (ws) => {
			if (!ws.url().includes(`/projects/${project.id}/events`)) return;
			const entry = { closed: false };
			sockets.push(entry);
			ws.on("close", () => {
				entry.closed = true;
			});
		});
		await page.goto(workspacePath(student.workspaceId, project.id));
		await expect(row(page, "README.md")).toBeVisible({ timeout: 15_000 });
		// The live region is there, empty, before the notice arrives, so a
		// screen reader announces the notice when it is inserted.
		const region = page.getByTestId("files-watch-limited-region");
		await expect(region).toHaveAttribute("role", "status");
		await expect(region).toBeEmpty();

		await expect
			.poll(() =>
				pushEvent(student.workspaceId, project.slug, { type: "watch_limited" }),
			)
			.toBe(1);
		const notice = page.getByTestId("files-watch-limited");
		await expect(notice).toHaveText(
			"This project is too large to update live. It refreshes when you return to the window.",
		);
		await expect(region.getByTestId("files-watch-limited")).toBeVisible();

		// No live updates any more: the socket closes and is never reopened.
		// (The tree's own refetch-on-focus may still show new files, which is
		// the intended fallback, so the test does not assert a file stays hidden.)
		await expect.poll(() => sockets.every((socket) => socket.closed)).toBe(true);
		const opened = sockets.length;
		await page.waitForTimeout(3_000);
		expect(sockets.length).toBe(opened);
		await expect
			.poll(() =>
				pushEvent(student.workspaceId, project.slug, {
					type: "fs",
					paths: [],
					git: true,
					truncated: true,
				}),
			)
			.toBe(0);

		await seedFile(student.workspaceId, project.slug, "later.txt", "x\n");
		await page.evaluate(() => window.dispatchEvent(new Event("focus")));
		await expect(row(page, "later.txt")).toBeVisible();
		await expect(notice).toHaveCount(1);
	});
});
