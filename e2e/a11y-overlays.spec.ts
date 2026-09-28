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

	/** Issue #609 item 6: the dialog box itself draws no focus outline. */
	test("a dialog opened from a menu has no outline on the dialog box", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const project = await createProject(student.workspaceId, { name: "No Outline" });
		await page.goto(workspacePath(student.workspaceId));

		await openRename(page, project.id);
		const style = await page.getByRole("dialog").evaluate((element) => {
			// Radix may focus the box itself when nothing inside takes focus first.
			(element as HTMLElement).focus();
			return getComputedStyle(element).outlineStyle;
		});
		expect(style).toBe("none");
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

	/**
	 * Epic 25 M4: a menu hands focus back to its button as it closes. That
	 * focus must not open the button's tooltip, so the control beside it
	 * answers the very next click.
	 */
	test("after a menu closes, the next click reaches the neighbouring control", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const first = await createProject(student.workspaceId, { name: "Aa Neighbour" });
		const second = await createProject(student.workspaceId, { name: "Ab Neighbour" });
		await page.goto(workspacePath(student.workspaceId));
		const upper = page.getByTestId(`project-menu-${first.id}`);
		const lower = page.getByTestId(`project-menu-${second.id}`);
		await expect(lower).toBeVisible({ timeout: 15_000 });
		// The two buttons sit one above the other, where a tooltip would cover.
		const [a, b] = [await upper.boundingBox(), await lower.boundingBox()];
		expect((a?.y ?? 0) < (b?.y ?? 0)).toBe(true);

		await lower.click();
		await expect(
			page.getByRole("menu", { name: "Actions for Ab Neighbour" }),
		).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(lower).toBeFocused();
		await expect(page.getByRole("tooltip")).toHaveCount(0);

		await upper.click({ timeout: 2_000 });
		await expect(
			page.getByRole("menu", { name: "Actions for Aa Neighbour" }),
		).toBeVisible();
		await page.keyboard.press("Escape");

		// Hovering still names the button, and the pointer can move onto the
		// name without it closing (WCAG 1.4.13, hoverable).
		await page.mouse.move(0, 0);
		await lower.hover();
		const tooltip = page.getByRole("tooltip");
		await expect(tooltip).toBeVisible();
		const box = await page.locator(".pk-tooltip").boundingBox();
		if (!box) throw new Error("tooltip has no box");
		await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 5 });
		await page.waitForTimeout(300);
		await expect(page.locator(".pk-tooltip")).toBeVisible();
	});

	/** Once a menu has a check item, plain items line up with the check's text. */
	test("a menu with a check item lines every label up in one column", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const project = await createProject(student.workspaceId, { name: "Gutter" });
		await page.goto(workspacePath(student.workspaceId, project.id));
		await page.getByTestId("files-more").click();
		const menu = page.getByRole("menu", { name: "More file actions" });
		await expect(menu).toBeVisible({ timeout: 15_000 });
		const left = (name: string | RegExp, role: "menuitem" | "menuitemcheckbox") =>
			menu
				.getByRole(role, { name })
				.locator(".pk-menu-item-label")
				.evaluate((el) => el.getBoundingClientRect().left);
		const check = await left("Show hidden and generated files", "menuitemcheckbox");
		expect(await left("Upload files…", "menuitem")).toBe(check);
		expect(await left("Download project", "menuitem")).toBe(check);
		expect(await left(/^New file/, "menuitem")).toBe(check);
	});
});
