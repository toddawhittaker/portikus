/**
 * The project events socket stays open whichever right-pane tab is showing,
 * so a browser-open request and an on-disk change still reach the page when
 * the Files tab is hidden (SPEC.md §11.4, BROWSER-HANDLING.md §18).
 */
import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import {
	createProject,
	createStudent,
	openFileTab,
	pushEvent,
	seedFile,
	settledAxe,
	WCAG_TAGS,
	workspacePath,
	workTabs,
} from "./helpers";

function openRequest(workspaceId: string, requestId: string) {
	return {
		type: "browser.open.request",
		requestId,
		workspaceId,
		url: "https://github.com/login/device",
		brokerClass: "external",
		requestedAt: "2026-01-01T00:00:00.000Z",
	};
}

async function showRunningTab(page: Page, context: BrowserContext, name: string) {
	const student = await createStudent(context);
	const project = await createProject(student.workspaceId, { name });
	await page.goto(workspacePath(student.workspaceId, project.id));
	await expect(workTabs(page)).toBeVisible({ timeout: 15_000 });
	const runningTab = page.getByTestId("right-pane-tab-running");
	await runningTab.click();
	await expect(page.getByRole("complementary", { name: "Running" })).toBeVisible();
	await expect(runningTab).toBeFocused();
	return { student, project, runningTab };
}

test("a browser-open request shows its dialog while the Running tab is showing", async ({
	page,
	context,
}) => {
	const { student, project, runningTab } = await showRunningTab(
		page,
		context,
		"Hidden Files",
	);
	const request = openRequest(
		student.workspaceId,
		"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
	);
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
	// Focus moves into the dialog and the open dialog passes axe (SPEC.md §25.8).
	await expect(dialog).toBeFocused();
	const results = await (await settledAxe(page)).withTags(WCAG_TAGS).analyze();
	expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);

	await page.getByTestId("browser-open-cancel").click();
	await expect(dialog).toHaveCount(0);
	await expect(runningTab).toBeFocused();
});

test("focus returns to where it was after two queued browser-open requests are cancelled", async ({
	page,
	context,
}) => {
	const { student, project, runningTab } = await showRunningTab(
		page,
		context,
		"Queued Opens",
	);
	const first = openRequest(
		student.workspaceId,
		"cccccccc-cccc-4ccc-8ccc-cccccccccccc",
	);
	const second = openRequest(
		student.workspaceId,
		"dddddddd-dddd-4ddd-8ddd-dddddddddddd",
	);
	const dialog = page.getByTestId("browser-open-dialog");
	await expect
		.poll(
			async () => {
				const sent = await pushEvent(student.workspaceId, project.slug, first);
				return sent > 0 && (await dialog.isVisible());
			},
			{ timeout: 15_000 },
		)
		.toBe(true);
	expect(await pushEvent(student.workspaceId, project.slug, second)).toBeGreaterThan(0);

	await dialog.getByTestId("browser-open-cancel").click();
	await expect(dialog).toHaveCount(1);
	await expect(dialog).toBeFocused();
	await dialog.getByTestId("browser-open-cancel").click();
	await expect(dialog).toHaveCount(0);
	await expect(runningTab).toBeFocused();
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
