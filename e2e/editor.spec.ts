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
		// The two versions are shown side by side, not a bare prompt (#158).
		const conflict = page.getByTestId(`conflict-editor-${PATH}`);
		await expect(conflict).toBeVisible({ timeout: 30_000 });
		await expect(conflict).toContainText("// theirs");
		await expect(conflict).toContainText("// mine");

		await page.getByTestId("take-disk").click();
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

	test("a conflict can be put aside and the file saved later", async ({
		page,
		context,
	}) => {
		// Issue #158: the student can keep typing on their own side and
		// resolve the conflict when they are ready.
		const student = await createStudent(context);
		const project = await openFileTab(page, student, "Keep editing", PATH, CONTENT);
		await expect(lines(page)).toContainText("const answer = 42;", {
			timeout: 60_000,
		});

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
		await page.keyboard.type("!");
		await expect(page.getByTestId(`conflict-editor-${PATH}`)).toBeVisible({
			timeout: 30_000,
		});

		// Back to the editor, with the student's own text still in it.
		await page.getByTestId("keep-editing").click();
		await expect(page.getByTestId(`conflict-editor-${PATH}`)).toHaveCount(0);
		await expect(lines(page)).toContainText("// mine");
		await expect(status(page)).toHaveText("Conflict");

		// Their text goes to disk when they say so.
		await page.getByTestId("keep-mine").click();
		await expect(status(page)).toHaveText("Saved", { timeout: 15_000 });
		await expect
			.poll(async () => readSeededFile(student.workspaceId, project.slug, PATH), {
				timeout: 15_000,
			})
			.toContain("// mine");
	});

	test("Ctrl+F finds a match and Ctrl+H replaces it", async ({ page, context }) => {
		const student = await createStudent(context);
		const project = await openFileTab(
			page,
			student,
			"Find",
			PATH,
			"const answer = 42;\nconst other = 42;\n",
		);
		await expect(lines(page)).toContainText("const answer = 42;", {
			timeout: 60_000,
		});

		const editor = page.getByTestId(`editor-${PATH}`);
		await lines(page).click();
		await page.keyboard.press("Control+f");
		const find = editor.locator(".find-widget");
		await expect(find).toBeVisible();
		await page.keyboard.type("answer");
		// Monaco counts the matches and highlights them in the text.
		await expect(find.locator(".matchesCount")).toContainText("1");
		await expect(editor.locator(".findMatch, .currentFindMatch").first()).toBeVisible();

		await page.keyboard.press("Escape");
		await page.keyboard.press("Control+h");
		await expect(find).toBeVisible();
		await find.getByRole("textbox", { name: "Find" }).fill("answer");
		await find.getByRole("textbox", { name: "Replace" }).fill("result");
		// Replace all acts on every match without stepping through them.
		await find.getByLabel(/Replace All/i).click();

		await expect(lines(page)).toContainText("const result = 42;");
		await expect
			.poll(async () => readSeededFile(student.workspaceId, project.slug, PATH), {
				timeout: 15_000,
			})
			.toContain("const result = 42;");
	});

	test("the editor zooms on its own, by keys and by the bar", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		await openFileTab(page, student, "Zoom", PATH, CONTENT);
		await expect(lines(page)).toContainText("const answer = 42;", {
			timeout: 60_000,
		});

		const zoom = page.getByTestId(`editor-zoom-${PATH}`);
		await expect(zoom).toHaveText("100%");
		const fontSize = () =>
			lines(page).evaluate((node) => getComputedStyle(node).fontSize);
		const startSize = await fontSize();

		await lines(page).click();
		await page.keyboard.press("Control+Shift+Equal");
		await expect(zoom).toHaveText("110%");
		await page.keyboard.press("Control+Shift+Minus");
		await page.keyboard.press("Control+Shift+Minus");
		await expect(zoom).toHaveText("90%");
		expect(await fontSize()).not.toBe(startSize);

		await page.keyboard.press("Control+0");
		await expect(zoom).toHaveText("100%");
		expect(await fontSize()).toBe(startSize);

		// The bar under the editor does the same with the mouse.
		await page.getByLabel("Zoom in").click();
		await expect(zoom).toHaveText("110%");
		await page.getByRole("button", { name: "Reset" }).click();
		await expect(zoom).toHaveText("100%");

		// Ctrl with the wheel over the editor zooms it, and the editor takes the
		// event so the browser cannot zoom the page with it.
		const prevented = await page
			.getByTestId(`editor-${PATH}`)
			.locator(".pk-editor-host")
			.evaluate((node) => {
				const event = new WheelEvent("wheel", {
					deltaY: -120,
					ctrlKey: true,
					bubbles: true,
					cancelable: true,
				});
				node.dispatchEvent(event);
				return event.defaultPrevented;
			});
		expect(prevented).toBe(true);
		await expect(zoom).toHaveText("110%");
	});

	test("a shell hook with no useful extension is highlighted as shell", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const path = "hooks/pre-applypatch.sample";
		await openFileTab(page, student, "Shebang", path, "#!/bin/sh\nexit 0\n");

		await expect(page.getByTestId(`editor-language-${path}`)).toHaveText("shell", {
			timeout: 60_000,
		});
	});
});
