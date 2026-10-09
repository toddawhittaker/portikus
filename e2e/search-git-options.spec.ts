import { expect, type Page, test } from "@playwright/test";
import {
	createProject,
	createStudent,
	expectNoViolations,
	lastSearch,
	query,
	seedFile,
	seedGit,
	type TestStudent,
	workspacePath,
} from "./helpers";

/**
 * Search options (SPEC.md §11.5), the commit id of a detached HEAD
 * (SPEC.md §12.8), and comparing one file with a Git ref (SPEC.md §12.6).
 * The workspace agent is faked: a ref comparison is seeded as `ref:path`.
 */
test.describe("search options and Git refs", () => {
	// The diff loads Monaco, which the dev server transforms on first use.
	test.describe.configure({ timeout: 90_000 });

	const FILE = "src/app.ts";

	async function openSearch(page: Page, student: TestStudent, name: string) {
		const project = await createProject(student.workspaceId, { name });
		await seedFile(student.workspaceId, project.slug, FILE, "const answer = 42;\n");
		await page.goto(workspacePath(student.workspaceId, project.id));
		await page.getByTestId("search-open").click();
		await expect(page.getByTestId("search-panel")).toBeVisible();
		return project;
	}

	test("the three options are pressed toggles and each reaches the search", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const project = await openSearch(page, student, "Search options");
		const panel = page.getByTestId("search-panel");
		const names = ["Match case", "Whole word", "Regex"];
		for (const name of names) {
			await expect(panel.getByRole("button", { name })).toHaveAttribute(
				"aria-pressed",
				"false",
			);
		}

		await page.getByTestId("search-input").fill("answer");
		await expect
			.poll(() => lastSearch(student.workspaceId, project.slug))
			.toMatchObject({
				q: "answer",
				regex: false,
				caseSensitive: false,
				wholeWord: false,
			});

		for (const name of names) await panel.getByRole("button", { name }).click();
		for (const name of names) {
			await expect(panel.getByRole("button", { name })).toHaveAttribute(
				"aria-pressed",
				"true",
			);
		}
		await expect
			.poll(() => lastSearch(student.workspaceId, project.slug))
			.toMatchObject({
				q: "answer",
				regex: true,
				caseSensitive: true,
				wholeWord: true,
			});

		// SPEC.md §25.8: the toggles add no violation to the panel, in either theme.
		for (const scheme of ["light", "dark"] as const) {
			await page.emulateMedia({ colorScheme: scheme });
			await expectNoViolations(page, "[data-testid=search-panel]");
		}
	});

	test("a regular expression that is not valid is named and announced", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		await openSearch(page, student, "Search bad regex");

		await page
			.getByTestId("search-panel")
			.getByRole("button", { name: "Regex" })
			.click();
		await page.getByTestId("search-input").fill("(");

		await expect(page.getByTestId("search-error")).toHaveText(
			"That regular expression is not valid.",
		);
		await expect(page.getByTestId("search-status")).toHaveText(
			"That regular expression is not valid.",
		);
		// The field is marked wrong and names the message as its description.
		await expect(page.getByTestId("search-input")).toHaveAttribute(
			"aria-invalid",
			"true",
		);
		await expect(page.getByTestId("search-input")).toHaveAccessibleDescription(
			"That regular expression is not valid.",
		);

		// SPEC.md §25.8: the refused pattern adds no violation, in either theme.
		for (const scheme of ["light", "dark"] as const) {
			await page.emulateMedia({ colorScheme: scheme });
			await expectNoViolations(page, "[data-testid=search-panel]");
		}
		await page.emulateMedia({ colorScheme: "light" });

		// The same text as a literal is an ordinary search.
		await page
			.getByTestId("search-panel")
			.getByRole("button", { name: "Regex" })
			.click();
		await expect(page.getByTestId("search-error")).toHaveCount(0);
	});

	test("a detached HEAD shows its short commit id in the status bar", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const project = await createProject(student.workspaceId, { name: "Detached" });
		await seedGit(student.workspaceId, project.slug, {
			status: {
				repo: true,
				branch: null,
				detached: true,
				oid: "0123456789abcdef0123456789abcdef01234567",
				upstream: null,
				ahead: 0,
				behind: 0,
				conflicts: 0,
				entries: [],
				ignored: [],
				truncated: false,
			},
		});
		await page.goto(workspacePath(student.workspaceId, project.id));

		await expect(page.getByTestId("git-status")).toHaveText(
			"detached HEAD at 0123456 • 0 changes",
		);
	});

	test("a file is compared with a typed ref, and an unknown ref is announced", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const project = await createProject(student.workspaceId, { name: "Ref compare" });
		const diff = (before: string) => ({
			status: "M",
			before,
			after: "const answer = 42;\n",
			binary: false,
			tooLarge: false,
		});
		await seedGit(student.workspaceId, project.slug, {
			diffs: {
				[FILE]: diff("const answer = 1;\n"),
				[`v1.0:${FILE}`]: diff("const answer = 0;\n"),
			},
		});
		await query("update projects set layout = $2 where id = $1", [
			project.id,
			JSON.stringify({
				tabs: [{ id: `diff:${FILE}`, root: { type: "diff", path: FILE } }],
			}),
		]);
		await page.goto(workspacePath(student.workspaceId, project.id));
		const pane = page.getByTestId(`diff-pane-${FILE}`);
		await expect(pane).toBeVisible({ timeout: 15_000 });
		await expect(page.getByTestId("diff-sides")).toHaveText("Last commitYour changes");

		await pane.getByLabel("Compare with").selectOption("ref");
		await pane.getByLabel("Branch, tag, or commit").fill("v1.0");
		await pane.getByRole("button", { name: "Compare" }).click();

		await expect(page.getByTestId("diff-sides")).toHaveText("v1.0Your changes");
		await expect(pane).toContainText(`Diff with v1.0 · ${FILE}`);
		await expect(page.getByTestId(`diff-editor-${FILE}`)).toContainText(
			"const answer = 0;",
			{ timeout: 60_000 },
		);

		await pane.getByLabel("Branch, tag, or commit").fill("nope");
		await pane.getByRole("button", { name: "Compare" }).click();
		await expect(pane.getByRole("alert")).toHaveText(
			"That Git ref does not name a commit.",
		);

		// A ref that would read as an option is refused in the page.
		await pane.getByLabel("Branch, tag, or commit").fill("--output=x");
		await pane.getByRole("button", { name: "Compare" }).click();
		await expect(pane.getByRole("alert").first()).toBeVisible();
		await expect(pane.getByLabel("Branch, tag, or commit")).toHaveAttribute(
			"aria-invalid",
			"true",
		);

		// SPEC.md §25.8: the compare control adds no violation to the diff header.
		await expectNoViolations(page, "[data-testid=diff-compare]");

		// The choice is local: a reload compares with the last commit again.
		await page.reload();
		await page.getByTestId(`file-view-diff-${FILE}`).click();
		await expect(page.getByTestId("diff-sides")).toHaveText("Last commitYour changes");
		await expect(pane.getByLabel("Compare with")).toHaveValue("head");
	});
});
