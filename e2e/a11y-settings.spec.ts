/**
 * Screen-reader mode and the accessibility parts of Settings (SPEC.md §13.5
 * and §25.8; issues #357, #359, #363 and #373).
 */
import { expect, type Page, test } from "@playwright/test";
import {
	createProject,
	createStudent,
	expectConnected,
	openFileTab,
	terminalIds,
	WEB_ORIGIN,
	workspacePath,
	workTabs,
} from "./helpers";

async function openSettings(page: Page) {
	await page.getByTestId("me").click();
	await page.getByRole("menuitem", { name: "Settings" }).click();
	const dialog = page.getByTestId("dialog-editor-settings");
	await expect(dialog).toBeVisible();
	return dialog;
}

async function openTerminal(page: Page, workspaceId: string, projectId: string) {
	await page.getByTestId("launcher").click();
	await page.getByTestId("launcher-terminal").click();
	await expect(page.getByRole("tab", { name: "Terminal 1" })).toBeVisible();
	const [id] = await terminalIds(workspaceId, projectId);
	if (!id) throw new Error("the terminal row was not created");
	await expectConnected(page, id);
	return page.getByTestId(`terminal-pane-${id}`);
}

/** Store the student's choice before the page loads, as an earlier visit would. */
async function storeScreenReaderMode(page: Page, on: boolean) {
	const res = await page.request.put("/me/settings", {
		data: { screenReaderMode: on },
		headers: { origin: WEB_ORIGIN },
	});
	expect(res.status()).toBe(200);
}

test("screen-reader mode is off by default in terminals and the editor", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	await openFileTab(page, student, "SR Default", "notes.txt", "first line\n");
	await expect(
		page.getByRole("button", { name: "Turn on screen-reader mode" }),
	).toBeAttached();
	// Monaco labels its input "not accessible" while its support is off.
	const input = page
		.locator('[data-testid="file-pane-notes.txt"] [aria-roledescription="editor"]')
		.first();
	await expect(input).toHaveAttribute("aria-label", /not accessible/);
});

test("turning on screen-reader mode in Settings gives an open terminal its accessibility tree", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	const project = await createProject(student.workspaceId, { name: "SR Settings" });
	await storeScreenReaderMode(page, false);
	await page.goto(workspacePath(student.workspaceId, project.id));
	await expect(workTabs(page)).toBeVisible({ timeout: 15_000 });
	const pane = await openTerminal(page, student.workspaceId, project.id);
	await expect(pane.locator(".xterm-accessibility-tree")).toHaveCount(0);

	const dialog = await openSettings(page);
	const box = dialog.getByRole("checkbox", { name: /Screen reader mode/ });
	await expect(box).not.toBeChecked();
	await box.check();
	await page.getByTestId("editor-settings-save").click();
	await expect(dialog).toHaveCount(0);

	// Applied to the terminal already open, without a reload.
	await expect(pane.locator(".xterm-accessibility-tree")).toHaveCount(1);
});

test("the first Tab stop turns screen-reader mode on and off and says so", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	const project = await createProject(student.workspaceId, { name: "SR Skip" });
	await page.goto(workspacePath(student.workspaceId, project.id));
	await expect(workTabs(page)).toBeVisible({ timeout: 15_000 });

	// A fresh page: the first Tab lands on the toggle, shown while focused.
	await page.keyboard.press("Tab");
	const toggle = page.getByRole("button", { name: "Turn on screen-reader mode" });
	await expect(toggle).toBeFocused();
	await expect(toggle).toBeInViewport();

	await page.keyboard.press("Enter");
	await expect(page.getByTestId("screen-reader-status")).toHaveText(
		"Screen-reader mode is on.",
	);
	await expect(
		page.getByRole("button", { name: "Turn off screen-reader mode" }),
	).toBeFocused();

	// A terminal opened now starts in the mode.
	const pane = await openTerminal(page, student.workspaceId, project.id);
	await expect(pane.locator(".xterm-accessibility-tree")).toHaveCount(1);

	// Saved for the student: it survives a reload, and turns off the same way.
	await page.reload();
	await expect(workTabs(page)).toBeVisible({ timeout: 15_000 });
	await page.getByTestId("screen-reader-toggle").focus();
	await expect(
		page.getByRole("button", { name: "Turn off screen-reader mode" }),
	).toBeFocused();
	await page.keyboard.press("Enter");
	await expect(page.getByTestId("screen-reader-status")).toHaveText(
		"Screen-reader mode is off.",
	);
});

test("screen-reader mode turns on the editor's own screen-reader support", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	await storeScreenReaderMode(page, false);
	await openFileTab(
		page,
		student,
		"SR Editor",
		"notes.txt",
		"first line\nsecond line\n",
	);
	// Monaco's input, a textarea or a native edit-context element by browser.
	const input = page
		.locator('[data-testid="file-pane-notes.txt"] [aria-roledescription="editor"]')
		.first();
	await expect(input).toHaveAttribute("aria-label", /not accessible/);

	await page.getByTestId("screen-reader-toggle").focus();
	await page.keyboard.press("Enter");
	await expect(page.getByTestId("screen-reader-status")).toHaveText(
		"Screen-reader mode is on.",
	);

	// With support off Monaco labels its input "not accessible"; on, it does not.
	await expect(input).not.toHaveAttribute("aria-label", /not accessible/);
});

test("the terminal colours switch is named Light terminal", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	await page.goto(workspacePath(student.workspaceId));
	await expect(page.getByTestId("app-header")).toBeVisible({ timeout: 15_000 });

	const dialog = await openSettings(page);
	const toggle = dialog.getByRole("switch", { name: "Light terminal" });
	await expect(toggle).not.toBeChecked();
	await toggle.check();
	await expect(dialog.getByRole("switch", { name: "Light terminal" })).toBeChecked();
});

test("the keyboard and screen readers section lists the keys", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	await page.goto(workspacePath(student.workspaceId));
	await expect(page.getByTestId("app-header")).toBeVisible({ timeout: 15_000 });

	const dialog = await openSettings(page);
	await dialog.getByRole("button", { name: "Keyboard and screen readers" }).click();
	const section = dialog.getByRole("region", { name: "Keyboard and screen readers" });
	for (const keys of [
		"Alt+Shift+Q",
		"Ctrl+M",
		"Alt+F1",
		"Alt+Shift+Left Arrow",
		"Shift+F10",
		"F8",
	]) {
		await expect(section).toContainText(keys);
	}
	await expect(
		section.getByRole("region", { name: "What the terminal and editor cannot do" }),
	).toBeVisible();
});

test("a failed save is announced as an alert", async ({ page, context }) => {
	const student = await createStudent(context);
	await page.goto(workspacePath(student.workspaceId));
	await expect(page.getByTestId("app-header")).toBeVisible({ timeout: 15_000 });
	await page.route("**/me/settings", (route) =>
		route.request().method() === "PUT"
			? route.fulfill({
					status: 500,
					contentType: "application/json",
					body: JSON.stringify({ code: "INTERNAL", message: "Could not save." }),
				})
			: route.fallback(),
	);

	const dialog = await openSettings(page);
	await page.getByTestId("editor-settings-save").click();
	await expect(dialog.getByRole("alert")).toContainText("Could not save.");
});
