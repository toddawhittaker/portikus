/**
 * "Open N files" on the tree's selection menu opens the selection as a
 * pane-edge drop would: the first file as a split, the rest as tabs
 * (SPEC.md §11.2), with the keyboard alone.
 */
import { expect, type Page, test } from "@playwright/test";
import {
	createProject,
	createStudent,
	expectConnected,
	newTerminal,
	seedFile,
	terminalIds,
	workspacePath,
	workTabs,
} from "./helpers";

test.describe("tree selection opened from the menu", () => {
	// Monaco is a large chunk the dev server transforms on first use.
	test.describe.configure({ timeout: 90_000 });

	function row(page: Page, path: string) {
		return page.getByTestId(`file-row-${path}`);
	}

	test("two selected files open as a split and a tab", async ({ page, context }) => {
		const student = await createStudent(context);
		const project = await createProject(student.workspaceId, {
			name: "Open selection",
		});
		await seedFile(student.workspaceId, project.slug, "notes.md", "# notes\n");
		await seedFile(student.workspaceId, project.slug, "other.md", "# other\n");
		await page.goto(workspacePath(student.workspaceId, project.id));
		await expect(row(page, "notes.md")).toBeVisible({ timeout: 15_000 });
		await newTerminal(page);
		await expect
			.poll(async () => (await terminalIds(student.workspaceId, project.id)).length)
			.toBe(1);
		const [terminalId] = await terminalIds(student.workspaceId, project.id);
		if (!terminalId) throw new Error("the terminal row was not created");
		await expectConnected(page, terminalId);

		await row(page, "notes.md").focus();
		await page.keyboard.press("Shift+ArrowDown");
		await expect(row(page, "other.md")).toBeFocused();
		await expect(row(page, "notes.md")).toHaveAttribute("data-selected", "true");
		await page.keyboard.press("Shift+F10");
		const item = page.getByRole("menuitem", { name: "Open 2 files" });
		await expect(item).toBeVisible();
		// The menu opens on its first item, which is this one.
		await expect(item).toBeFocused();
		await page.keyboard.press("Enter");

		await expect(workTabs(page).getByRole("tab")).toHaveCount(2);
		await expect(page.getByTestId("tab-file:other.md")).toBeVisible();
		await expect(page.getByTestId(`tab-${terminalId}`)).toHaveAttribute(
			"aria-selected",
			"true",
		);
		const group = page.getByTestId(`terminal-group-${terminalId}`);
		await expect(group.getByTestId(`terminal-leaf-${terminalId}`)).toBeVisible();
		await expect(group.getByTestId("file-frame-notes.md")).toBeVisible();
	});
});
