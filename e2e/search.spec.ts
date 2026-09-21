import { expect, type Page, test } from "@playwright/test";
import {
	createProject,
	createStudent,
	lastSearch,
	seedFile,
	seedSearch,
	type TestStudent,
	workspacePath,
} from "./helpers";

/**
 * Find in files and the "open this file at this line" route (SPEC.md §11.5,
 * §14.9). The workspace agent is faked, so the matches are seeded.
 */
test.describe("project search", () => {
	// Opening a result loads Monaco, which the dev server transforms on first
	// use, so this file gets the same room the editor tests get.
	test.describe.configure({ timeout: 90_000 });

	const FILE = "src/app.ts";
	const TEXT = "const answer = 42;\nconst other = 1;\nexport const answer2 = 43;\n";

	function match(path: string, line: number, column: number, text: string) {
		return { path, line, column, text, before: [], after: [] };
	}

	/** Open a project and put the search panel on screen. */
	async function openSearch(page: Page, student: TestStudent, name: string) {
		const project = await createProject(student.workspaceId, { name });
		await seedFile(student.workspaceId, project.slug, FILE, TEXT);
		await page.goto(workspacePath(student.workspaceId, project.id));
		await page.getByTestId("search-open").click();
		await expect(page.getByTestId("search-panel")).toBeVisible();
		return project;
	}

	test("typing shows matches grouped by file, with the match highlighted", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const project = await openSearch(page, student, "Search grouping");
		await seedSearch(student.workspaceId, project.slug, [
			match(FILE, 1, 7, "const answer = 42;"),
			match(FILE, 3, 14, "export const answer2 = 43;"),
			match("docs/notes.md", 5, 1, "answer written down"),
		]);

		await page.getByTestId("search-input").fill("answer");

		await expect(page.getByTestId(`search-group-${FILE}`)).toBeVisible();
		await expect(page.getByTestId("search-group-docs/notes.md")).toBeVisible();
		const row = page.getByTestId(`search-result-${FILE}-1`);
		await expect(row).toContainText("const answer = 42;");
		await expect(row.locator("mark")).toHaveText("answer");
		await expect(page.getByTestId("search-truncated")).toBeHidden();
	});

	test("a truncated search says only the first matches are shown", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const project = await openSearch(page, student, "Search truncated");
		await seedSearch(
			student.workspaceId,
			project.slug,
			[match(FILE, 1, 7, "const answer = 42;")],
			true,
		);

		await page.getByTestId("search-input").fill("answer");

		await expect(page.getByTestId("search-truncated")).toHaveText(
			"Showing the first matches only. Narrow the search to see the rest.",
		);
	});

	test("including hidden files changes what the agent is asked", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const project = await openSearch(page, student, "Search hidden");
		await seedSearch(student.workspaceId, project.slug, []);

		await page.getByTestId("search-input").fill("answer");
		await expect
			.poll(() =>
				lastSearch(student.workspaceId, project.slug).then((last) => last?.hidden),
			)
			.toBe(false);

		await page.getByLabel("Include hidden and generated files").check();

		await expect
			.poll(() => lastSearch(student.workspaceId, project.slug).then((last) => last))
			.toEqual({ q: "answer", hidden: true });
	});

	test("a search with no matches says so, and closing goes back to the files", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const project = await openSearch(page, student, "Search empty");
		await seedSearch(student.workspaceId, project.slug, []);

		await page.getByTestId("search-input").fill("nothing here");
		await expect(page.getByTestId("search-empty")).toBeVisible();

		await page.getByTestId("search-close").click();

		await expect(page.getByTestId("search-panel")).toBeHidden();
		await expect(page.getByTestId("search-open")).toBeVisible();
	});

	test("a result opens the file in the editor at its line", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const project = await openSearch(page, student, "Search open");
		await seedSearch(student.workspaceId, project.slug, [
			match(FILE, 3, 14, "export const answer2 = 43;"),
		]);

		await page.getByTestId("search-input").fill("answer2");
		await page.getByTestId(`search-result-${FILE}-3`).click();

		await expect(page.getByTestId(`file-pane-${FILE}`)).toBeVisible({
			timeout: 30_000,
		});
		await expect(
			page.getByTestId(`editor-${FILE}`).locator(".view-lines"),
		).toContainText("const answer = 42;", { timeout: 60_000 });
		await expect(page.locator(".active-line-number")).toHaveText("3");
	});

	test("a file link lands in the editor at its line", async ({ page, context }) => {
		// The Epic 5 acceptance: `src/app.ts:3` printed in a terminal
		// (SPEC.md §14.9).
		const student = await createStudent(context);
		const project = await createProject(student.workspaceId, { name: "File link" });
		await seedFile(student.workspaceId, project.slug, FILE, TEXT);

		await page.goto(
			`${workspacePath(student.workspaceId, project.id)}/files?path=${FILE}&line=3`,
		);

		await expect(page.getByTestId(`file-pane-${FILE}`)).toBeVisible({
			timeout: 30_000,
		});
		await expect(
			page.getByTestId(`editor-${FILE}`).locator(".view-lines"),
		).toContainText("const answer = 42;", { timeout: 60_000 });
		await expect(page.locator(".active-line-number")).toHaveText("3");
	});

	test("Mod+Shift+F opens the search", async ({ page, context }) => {
		const student = await createStudent(context);
		const project = await createProject(student.workspaceId, {
			name: "Search shortcut",
		});
		await page.goto(workspacePath(student.workspaceId, project.id));
		await expect(page.getByTestId("search-open")).toBeVisible();
		// The header's placeholder search icon is gone (issue #241); the files
		// pane and this shortcut are the only ways in.
		await expect(
			page.getByTestId("app-header").getByRole("button", { name: /search/i }),
		).toHaveCount(0);

		await page.keyboard.press("ControlOrMeta+Shift+F");

		await expect(page.getByTestId("search-panel")).toBeVisible();
	});
});
