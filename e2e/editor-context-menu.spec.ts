import { expect, type Page, test } from "@playwright/test";
import {
	codeHelpStatus,
	cursorBelowFirstLine,
	editorLines,
	editorMessage,
	holdCodeHelpSwitch,
	openProjectFiles,
	renameTo,
	saveQuickly,
	watchLanguageServers,
} from "./code-help-helpers";
import { createStudent, seedGit } from "./helpers";

/**
 * The editor's right-click menu and code-help keys keep working after the
 * file has been shown as a diff and back (SPEC.md §13.6, §12.6).
 */
test.describe("editor after a diff round trip", () => {
	test.describe.configure({ timeout: 120_000 });
	holdCodeHelpSwitch(test);

	const PATH = "app.py";

	async function open(page: Page) {
		const student = await createStudent(page.context());
		const wire = await watchLanguageServers(page);
		await saveQuickly(student.userId);
		const project = await openProjectFiles(page, student, "Menu", {
			[PATH]: "answer = 42\nother = answer\n",
		});
		await seedGit(student.workspaceId, project.slug, {
			diffs: {
				[PATH]: {
					status: "M",
					before: "answer = 1\n",
					after: "answer = 42\nother = answer\n",
					binary: false,
					tooLarge: false,
				},
			},
		});
		await expect(editorLines(page, PATH)).toContainText("answer = 42", {
			timeout: 60_000,
		});
		await expect(codeHelpStatus(page, PATH)).toHaveText("Code help ready", {
			timeout: 30_000,
		});
		return wire;
	}

	async function roundTrip(page: Page) {
		await page.getByTestId(`file-view-diff-${PATH}`).click();
		await expect(
			page.getByTestId(`diff-editor-${PATH}`).locator(".monaco-diff-editor"),
		).toBeVisible({ timeout: 60_000 });
		await page.getByTestId(`file-view-edit-${PATH}`).click();
		await expect(editorLines(page, PATH)).toBeVisible();
		await editorLines(page, PATH).click();
	}

	test("the right-click menu still runs Format Document", async ({ page }) => {
		await open(page);
		const menu = page.locator(".monaco-menu-container");

		await editorLines(page, PATH).click({ button: "right" });
		await expect(menu).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(menu).toBeHidden();

		await roundTrip(page);

		await editorLines(page, PATH).click({ button: "right" });
		await expect(menu).toBeVisible();
		// Playwright's click on a Monaco menu item does not run it, so the
		// item is pointed at and chosen with Enter.
		await menu.getByRole("menuitem", { name: /Format Document/ }).hover();
		await page.keyboard.press("Enter");
		await expect(editorLines(page, PATH)).toContainText("# formatted");
	});

	test("Ctrl+Space still offers completions", async ({ page }) => {
		await open(page);
		await roundTrip(page);
		await page.keyboard.press("Control+Home");

		await page.keyboard.press("Control+Space");
		await expect(page.locator(".suggest-widget")).toContainText("portikus_example");
	});

	test("F12 still goes to the definition", async ({ page }) => {
		const wire = await open(page);
		await roundTrip(page);
		await page.keyboard.press("Control+End");
		await page.keyboard.press("ArrowUp");
		await expect.poll(() => cursorBelowFirstLine(page)).toBeGreaterThan(10);

		await page.keyboard.press("F12");
		await expect
			.poll(() => wire.sentWith("textDocument/definition", "python").length)
			.toBe(1);
		await expect.poll(() => cursorBelowFirstLine(page)).toBeLessThan(2);
	});

	test("F2 still renames", async ({ page }) => {
		await open(page);
		await roundTrip(page);
		await page.keyboard.press("Control+Home");

		await renameTo(page, "renamed");
		await expect(editorMessage(page)).toHaveText("Renamed in 1 file.");
	});
});
