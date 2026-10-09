import { expect, type Page, test } from "@playwright/test";
import {
	createProject,
	createStudent,
	expectNoViolations,
	seedFile,
	type TestProject,
	workspacePath,
} from "./helpers";
import { FAKE_AGENT_URL } from "./ports";

/**
 * When the focused file tree row disappears, the keyboard focus moves to the
 * nearest row instead of falling to the page (SPEC.md §25.8).
 */
test.describe("file tree focus when a row is removed", () => {
	async function openProject(
		page: Page,
		workspaceId: string,
		name: string,
	): Promise<TestProject> {
		const project = await createProject(workspaceId, { name });
		for (const path of ["src/a.ts", "src/b.ts", "src/c.ts", "README.md"]) {
			await seedFile(workspaceId, project.slug, path, "x\n");
		}
		await page.goto(workspacePath(workspaceId, project.id));
		await expect(page.getByTestId("file-tree")).toBeVisible({ timeout: 15_000 });
		return project;
	}

	/** Delete a file the way a shell in the workspace would. */
	async function removeInShell(workspaceId: string, slug: string, path: string) {
		const query = new URLSearchParams({ key: workspaceId, path: `${slug}/${path}` });
		const response = await fetch(`${FAKE_AGENT_URL}/__test/files?${query}`, {
			method: "DELETE",
		});
		if (!response.ok)
			throw new Error(`the fake agent kept ${path}: ${response.status}`);
	}

	function row(page: Page, path: string) {
		return page.getByTestId(`file-row-${path}`);
	}

	/** Open src and put the keyboard on src/b.ts. */
	async function focusMiddleFile(page: Page) {
		await row(page, "src").focus();
		await page.keyboard.press("ArrowRight");
		await expect(row(page, "src/b.ts")).toBeVisible();
		await page.keyboard.press("ArrowDown");
		await page.keyboard.press("ArrowDown");
		await expect(row(page, "src/b.ts")).toBeFocused();
	}

	test("a file deleted in a shell hands the focus to the next row, then the one above", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const project = await openProject(page, student.workspaceId, "Focus Shell");
		await focusMiddleFile(page);

		await removeInShell(student.workspaceId, project.slug, "src/b.ts");
		await expect(row(page, "src/b.ts")).toHaveCount(0, { timeout: 10_000 });
		await expect(row(page, "src/c.ts")).toBeFocused();
		await expect(row(page, "src/c.ts")).toHaveAttribute("tabindex", "0");

		// The last file in the folder has no next sibling, so the row above takes it.
		await removeInShell(student.workspaceId, project.slug, "src/c.ts");
		await expect(row(page, "src/c.ts")).toHaveCount(0, { timeout: 10_000 });
		await expect(row(page, "src/a.ts")).toBeFocused();

		// The keyboard carries on from there.
		await page.keyboard.press("ArrowDown");
		await expect(row(page, "README.md")).toBeFocused();
	});

	test("a file deleted from the keyboard leaves the focus on its neighbour", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		await openProject(page, student.workspaceId, "Focus Delete");
		await focusMiddleFile(page);

		await page.keyboard.press("Delete");
		const dialog = page.getByTestId("dialog-delete-file");
		await expect(dialog).toBeVisible();
		await dialog.getByTestId("dialog-confirm").click();

		await expect(row(page, "src/b.ts")).toHaveCount(0);
		await expect(row(page, "src/c.ts")).toBeFocused();
	});

	test("focus somewhere else stays there when a row goes", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const project = await openProject(page, student.workspaceId, "Focus Elsewhere");
		await focusMiddleFile(page);
		const search = page.getByTestId("search-open");
		await search.focus();

		await removeInShell(student.workspaceId, project.slug, "src/b.ts");
		await expect(row(page, "src/b.ts")).toHaveCount(0, { timeout: 10_000 });
		await expect(row(page, "src/c.ts")).toHaveAttribute("tabindex", "0");
		await expect(search).toBeFocused();
	});

	for (const theme of ["light", "dark"] as const) {
		test(`the tree after a removal passes axe in the ${theme} theme`, async ({
			page,
			context,
		}) => {
			await context.addInitScript((value) => {
				localStorage.setItem("pk-theme", value);
			}, theme);
			const student = await createStudent(context);
			const project = await openProject(
				page,
				student.workspaceId,
				`Focus Axe ${theme}`,
			);
			await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
			await focusMiddleFile(page);

			await removeInShell(student.workspaceId, project.slug, "src/b.ts");
			await expect(row(page, "src/c.ts")).toBeFocused({ timeout: 10_000 });

			await expectNoViolations(page, '[data-testid="file-tree"]');
		});
	}
});
