import { expect, type Page, test } from "@playwright/test";
import { createStudent, openFileTab, readSeededFile, seedFile } from "./helpers";

/**
 * The file editor: autosave, external refresh, conflicts and the viewer for
 * files that cannot be edited (SPEC.md §13.1, §13.2, §13.3, §13.5).
 */
test.describe("file editor", () => {
	// Monaco is a large chunk the dev server transforms on first use, so the
	// first run of this file is much slower than the rest of the suite.
	test.describe.configure({ timeout: 90_000 });

	const PATH = "src/app.ts";

	const CONTENT = "const answer = 42;\n";

	function status(page: Page, path = PATH) {
		return page.getByTestId(`file-status-${path}`);
	}

	/** Monaco paints the text into `.view-lines`. */
	function lines(page: Page, path = PATH) {
		return page.getByTestId(`editor-${path}`).locator(".view-lines");
	}

	test("a file opens in the editor and typing autosaves it", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const project = await openFileTab(page, student, "Editing", PATH, CONTENT);

		await expect(lines(page)).toContainText("const answer = 42;", {
			timeout: 60_000,
		});
		await expect(status(page)).toHaveText("Saved");

		await lines(page).click();
		await page.keyboard.press("End");
		await page.keyboard.type(" // hello");
		await expect(lines(page)).toContainText("// hello");
		await expect(status(page)).toHaveText("Saved", { timeout: 15_000 });
		await expect
			.poll(async () => readSeededFile(student.workspaceId, project.slug, PATH), {
				timeout: 15_000,
			})
			.toContain("// hello");
	});

	test("typing on and on never claims the file changed on disk", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const project = await openFileTab(
			page,
			student,
			"No false conflict",
			PATH,
			CONTENT,
		);
		await expect(lines(page)).toContainText("const answer = 42;", {
			timeout: 60_000,
		});

		// Hold each save's answer back for a moment. The file has already
		// changed on disk by then, so the project events socket reports the
		// editor's own write before the write's answer arrives, which is what
		// made the pilot show a conflict (issue #157).
		await page.route(/\/file\?path=/, async (route) => {
			if (route.request().method() !== "PUT") {
				await route.continue();
				return;
			}
			// The write reaches the server at once; only its answer is late.
			const response = await route.fetch();
			await new Promise((resolve) => setTimeout(resolve, 1500));
			await route.fulfill({ response });
		});

		// Keep typing through several autosaves. None of them is an outside
		// change, so the conflict prompt must never appear.
		await lines(page).click();
		await page.keyboard.press("End");
		for (const word of [" // one", " two", " three", " four"]) {
			await page.keyboard.type(word);
			await page.waitForTimeout(3000);
			await expect(page.getByTestId("file-conflict")).toHaveCount(0);
		}

		await expect(status(page)).toHaveText("Saved", { timeout: 15_000 });
		await expect(page.getByTestId("file-conflict")).toHaveCount(0);
		await expect
			.poll(async () => readSeededFile(student.workspaceId, project.slug, PATH), {
				timeout: 15_000,
			})
			.toContain("// one two three four");
	});

	test("a change on disk refreshes an editor with no local edits", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const project = await openFileTab(page, student, "Refresh", PATH, CONTENT);
		await expect(lines(page)).toContainText("const answer = 42;", {
			timeout: 60_000,
		});

		// What a coding agent or a shell command would do.
		await seedFile(
			student.workspaceId,
			project.slug,
			PATH,
			"const answer = 7; // from the agent\n",
		);
		await expect(lines(page)).toContainText("from the agent", { timeout: 20_000 });
		await expect(status(page)).toHaveText("Saved");
	});

	test("a change on disk while editing is a conflict the student resolves", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const project = await openFileTab(page, student, "Conflict", PATH, CONTENT);
		await expect(lines(page)).toContainText("const answer = 42;", {
			timeout: 60_000,
		});

		// Save the local edit first, so the conflict is only about the change
		// that lands on disk afterwards and the test cannot race the debounce.
		await lines(page).click();
		await page.keyboard.press("End");
		await page.keyboard.type(" // mine");
		await expect(status(page)).toHaveText("Saved", { timeout: 15_000 });

		await seedFile(
			student.workspaceId,
			project.slug,
			PATH,
			"const answer = 7; // theirs\n",
		);
		// One more keystroke makes the tab dirty against the version it read,
		// which is what turns the change on disk into a conflict.
		await page.keyboard.type("!");

		await expect(page.getByTestId("file-conflict")).toBeVisible({ timeout: 20_000 });
		await expect(status(page)).toHaveText("Conflict");

		await page.getByTestId("take-theirs").click();
		await expect(lines(page)).toContainText("// theirs");
		await expect(page.getByTestId("file-conflict")).toHaveCount(0);
		await expect(status(page)).toHaveText("Saved");
	});

	test("Keep mine writes the local text over the file on disk", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const project = await openFileTab(page, student, "Keep mine", PATH, CONTENT);
		await expect(lines(page)).toContainText("const answer = 42;", {
			timeout: 60_000,
		});

		// Save the local edit first, so the conflict is only about the change
		// that lands on disk afterwards and the test cannot race the debounce.
		await lines(page).click();
		await page.keyboard.press("End");
		await page.keyboard.type(" // mine");
		await expect(status(page)).toHaveText("Saved", { timeout: 15_000 });

		await seedFile(
			student.workspaceId,
			project.slug,
			PATH,
			"const answer = 7; // theirs\n",
		);
		// One more keystroke makes the tab dirty against the version it read,
		// which is what turns the change on disk into a conflict.
		await page.keyboard.type("!");
		await expect(page.getByTestId("file-conflict")).toBeVisible({ timeout: 20_000 });

		await page.getByTestId("keep-mine").click();
		await expect(status(page)).toHaveText("Saved", { timeout: 15_000 });
		await expect
			.poll(async () => readSeededFile(student.workspaceId, project.slug, PATH), {
				timeout: 15_000,
			})
			.toContain("// mine");
	});

	test("a binary file offers a download instead of the editor", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const path = "assets/logo.png";
		await openFileTab(page, student, "Binary", path, "\u0000\u0001PNG\u0000");

		await expect(page.getByTestId("file-download")).toBeVisible({ timeout: 15_000 });
		await expect(page.getByTestId(`editor-${path}`)).toHaveCount(0);
		await expect(page.getByTestId("file-download")).toHaveAttribute(
			"href",
			/download=1/,
		);
	});
});
