/**
 * The project events socket stays open whichever right-pane tab is showing,
 * so a browser-open request and an on-disk change still reach the page when
 * the Files tab is hidden (SPEC.md §11.4, BROWSER-HANDLING.md §18).
 */
import { expect, test } from "@playwright/test";
import {
	createProject,
	createStudent,
	openFileTab,
	pushEvent,
	seedFile,
	workspacePath,
	workTabs,
} from "./helpers";

test("a browser-open request shows its dialog while the Running tab is showing", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	const project = await createProject(student.workspaceId, { name: "Hidden Files" });
	await page.goto(workspacePath(student.workspaceId, project.id));
	await expect(workTabs(page)).toBeVisible({ timeout: 15_000 });
	await page.getByTestId("right-pane-tab-running").click();
	await expect(page.getByRole("complementary", { name: "Running" })).toBeVisible();

	const request = {
		type: "browser.open.request",
		requestId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
		workspaceId: student.workspaceId,
		url: "https://github.com/login/device",
		brokerClass: "external",
		requestedAt: "2026-01-01T00:00:00.000Z",
	};
	// A subscriber can be a socket that is already closing (React's development
	// double mount), so push again until the dialog shows; repeats are ignored.
	const dialog = page.getByTestId("browser-open-dialog");
	await expect
		.poll(
			async () => {
				const sent = await pushEvent(student.workspaceId, project.slug, request);
				return sent > 0 && (await dialog.isVisible());
			},
			{ timeout: 15_000 },
		)
		.toBe(true);
	await page.getByTestId("browser-open-cancel").click();
	await expect(dialog).toHaveCount(0);
});

test("an on-disk change reaches an open editor tab while the Monitor tab is showing", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	const path = "notes.txt";
	const project = await openFileTab(page, student, "Hidden Edit", path, "before\n");
	const lines = page.getByTestId(`editor-${path}`).locator(".view-lines");
	await expect(lines).toContainText("before", { timeout: 60_000 });
	await page.getByTestId("right-pane-tab-monitor").click();
	await expect(page.getByRole("complementary", { name: "Monitor" })).toBeVisible();

	await seedFile(student.workspaceId, project.slug, path, "after\n");
	await expect
		.poll(
			async () => {
				await pushEvent(student.workspaceId, project.slug, {
					type: "fs",
					paths: [path],
					git: false,
					truncated: false,
				});
				return lines.textContent();
			},
			{ timeout: 15_000 },
		)
		.toContain("after");
});
