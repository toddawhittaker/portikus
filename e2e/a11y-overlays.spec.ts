import { expect, type Page, test } from "@playwright/test";
import { createProject, createStudent, seedFile, workspacePath } from "./helpers";

/**
 * Shared overlays (SPEC.md §25.8, DESIGN.md §6): focus returns somewhere
 * sensible when a dialog closes (issue #358), and toasts sit above dialogs
 * (issue #364).
 */
test.describe("accessible overlays", () => {
	/** Open the Rename dialog from a project's "more" menu. */
	async function openRename(page: Page, projectId: string): Promise<void> {
		await page.getByTestId(`project-menu-${projectId}`).click();
		await page.getByRole("menuitem", { name: "Rename" }).click();
		await expect(page.getByRole("dialog")).toBeVisible();
	}

	test("closing a dialog opened from a menu returns focus to the menu button", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const project = await createProject(student.workspaceId, { name: "Focus Home" });
		await page.goto(workspacePath(student.workspaceId));

		await openRename(page, project.id);
		await page.keyboard.press("Escape");

		await expect(page.getByRole("dialog")).toHaveCount(0);
		await expect(page.getByTestId(`project-menu-${project.id}`)).toBeFocused();
	});

	test("closing a confirmation opened from a menu returns focus to the menu button", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const project = await createProject(student.workspaceId, { name: "Focus Confirm" });
		await page.goto(workspacePath(student.workspaceId));

		await page.getByTestId(`project-menu-${project.id}`).click();
		await page.getByRole("menuitem", { name: "Archive" }).click();
		await expect(page.getByRole("alertdialog")).toBeVisible();
		await page.keyboard.press("Escape");

		await expect(page.getByRole("alertdialog")).toHaveCount(0);
		await expect(page.getByTestId(`project-menu-${project.id}`)).toBeFocused();
	});

	/** Issue #358 remainder: a file row's menu has no trigger button in the Tab order. */
	for (const item of ["row-move", "row-delete"]) {
		test(`closing the ${item} dialog from a file row menu returns focus to the row`, async ({
			page,
			context,
		}) => {
			const student = await createStudent(context);
			const project = await createProject(student.workspaceId, { name: `Row ${item}` });
			await seedFile(student.workspaceId, project.slug, "README.md", "# hi\n");
			await seedFile(student.workspaceId, project.slug, "src/app.ts", "export {};\n");
			await page.goto(workspacePath(student.workspaceId, project.id));
			const row = page.getByTestId("file-row-README.md");
			await expect(row).toBeVisible({ timeout: 15_000 });

			await row.focus();
			await page.keyboard.press("Shift+F10");
			await page.getByTestId(item).click();
			const dialog = page.locator("[role=dialog], [role=alertdialog]");
			await expect(dialog).toBeVisible();
			await page.keyboard.press("Escape");

			await expect(dialog).toHaveCount(0);
			await expect(row).toBeFocused();
		});
	}

	test("closing a dialog opened from a file row's right-click menu returns focus to the row", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const project = await createProject(student.workspaceId, { name: "Row Right" });
		await seedFile(student.workspaceId, project.slug, "README.md", "# hi\n");
		await page.goto(workspacePath(student.workspaceId, project.id));
		const row = page.getByTestId("file-row-README.md");
		await expect(row).toBeVisible({ timeout: 15_000 });

		await row.click({ button: "right" });
		await page.getByRole("menuitem", { name: /Delete/ }).click();
		const dialog = page.getByRole("alertdialog");
		await expect(dialog).toBeVisible();
		await page.keyboard.press("Escape");

		await expect(dialog).toHaveCount(0);
		await expect(row).toBeFocused();
	});

	test("the toast layer sits above an open dialog", async ({ page, context }) => {
		const student = await createStudent(context);
		const project = await createProject(student.workspaceId, { name: "Toast Layer" });
		await page.goto(workspacePath(student.workspaceId));

		await openRename(page, project.id);

		const zIndex = (selector: string) =>
			page
				.locator(selector)
				.first()
				.evaluate((node) => Number(getComputedStyle(node).zIndex));
		const toastLayer = await zIndex(".pk-toast-viewport");
		expect(toastLayer).toBeGreaterThan(await zIndex(".pk-dialog"));
		expect(toastLayer).toBeGreaterThan(await zIndex(".pk-scrim"));
		// F8 is the only keyboard route to a toast, so the region names it. The
		// open modal hides the region from the tree, hence includeHidden.
		await expect(
			page.getByRole("region", { name: /F8/, includeHidden: true }),
		).toBeAttached();
	});
});
