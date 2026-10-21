import { expect, type Page, test } from "@playwright/test";
import {
	codeHelpStatus,
	cursorBelowFirstLine,
	editorLines,
	editorMessage,
	holdCodeHelpSwitch,
	hoverWidget,
	type LanguageServerId,
	monacoAnnouncements,
	openProjectFiles,
	renameTo,
	saveQuickly,
	serverUriOf,
	watchLanguageServers,
} from "./code-help-helpers";
import { createStudent, readSeededFile, type TestStudent } from "./helpers";

/**
 * The six features of code help in the editor, through the real API relay to
 * the fake agent's scripted language server (SPEC.md §13.6).
 */
test.describe("code help features", () => {
	test.describe.configure({ timeout: 120_000 });
	holdCodeHelpSwitch(test);

	interface Sample {
		path: string;
		first: string;
		second: string;
		/** The server that answers everything but formatting. */
		server: LanguageServerId;
		/** The server that formats. */
		formatter: LanguageServerId;
	}

	const SAMPLES: Sample[] = [
		{
			path: "src/app.ts",
			first: "const answer = 42;",
			second: "const other = answer;",
			server: "typescript",
			formatter: "typescript",
		},
		{
			path: "app.py",
			first: "answer = 42",
			second: "other = answer",
			server: "python",
			formatter: "ruff",
		},
	];

	async function open(page: Page, sample: Sample, student: TestStudent) {
		const wire = await watchLanguageServers(page);
		await saveQuickly(student.userId);
		const project = await openProjectFiles(page, student, "Features", {
			[sample.path]: `${sample.first}\n${sample.second}\n`,
		});
		await expect(editorLines(page, sample.path)).toContainText(sample.first, {
			timeout: 60_000,
		});
		await expect(codeHelpStatus(page, sample.path)).toHaveText("Code help ready", {
			timeout: 30_000,
		});
		await editorLines(page, sample.path).click();
		await page.keyboard.press("Control+Home");
		return { wire, project };
	}

	for (const sample of SAMPLES) {
		test.describe(sample.path, () => {
			test("completion offers what the server answers", async ({ page, context }) => {
				const student = await createStudent(context);
				const { wire } = await open(page, sample, student);

				await page.keyboard.press("Control+Space");
				const widget = page.locator(".suggest-widget");
				await expect(widget).toContainText("portikus_example");
				await expect(widget).toContainText("portikus_value");
				await page.keyboard.press("Enter");
				await expect(editorLines(page, sample.path)).toContainText("portikus_example");
				expect(wire.sentWith("textDocument/completion", sample.server)).toHaveLength(1);
			});

			test("hover shows the server's text", async ({ page, context }) => {
				const student = await createStudent(context);
				const { wire } = await open(page, sample, student);

				await page
					.getByTestId(`editor-${sample.path}`)
					.locator(".view-line")
					.first()
					.hover({ position: { x: 2, y: 6 } });
				const hover = hoverWidget(page);
				await expect(hover).toContainText("scripted hover");
				// The Markdown is rendered, so the bold marks are not left in the text.
				await expect(hover.locator("strong")).toHaveText("scripted hover");
				expect(wire.sentWith("textDocument/hover", sample.server)).not.toHaveLength(0);
			});

			test("go to definition moves to the target in the same file", async ({
				page,
				context,
			}) => {
				const student = await createStudent(context);
				const { wire } = await open(page, sample, student);

				await page.keyboard.press("Control+End");
				await page.keyboard.press("ArrowUp");
				await expect.poll(() => cursorBelowFirstLine(page)).toBeGreaterThan(10);
				await page.keyboard.press("F12");
				await expect
					.poll(() => wire.sentWith("textDocument/definition", sample.server).length)
					.toBe(1);
				// The scripted target is the first character: the cursor moves there.
				await expect.poll(() => cursorBelowFirstLine(page)).toBeLessThan(2);
				await page.keyboard.type("Z");
				await expect(editorLines(page, sample.path)).toContainText(`Z${sample.first}`);
			});

			test("rename inside the project edits the file and saves it", async ({
				page,
				context,
			}) => {
				const student = await createStudent(context);
				const { project } = await open(page, sample, student);

				await renameTo(page, "renamed");
				await expect(editorMessage(page)).toHaveText("Renamed in 1 file.");
				// One announcement: Monaco's own "Made 0 edits in 0 files" is not made.
				await page.waitForTimeout(500);
				await expect(monacoAnnouncements(page)).not.toContainText("renamed");
				await expect(monacoAnnouncements(page)).not.toContainText("Made");
				// The scripted edit replaces the first character with the new name.
				await expect(editorLines(page, sample.path)).toContainText(
					sample.first.slice(1),
				);
				await expect
					.poll(
						async () => readSeededFile(student.workspaceId, project.slug, sample.path),
						{
							timeout: 20_000,
						},
					)
					.toBe(`renamed${sample.first.slice(1)}\n${sample.second}\n`);
			});

			test("format asks the right server and applies its edits", async ({
				page,
				context,
			}) => {
				const student = await createStudent(context);
				const { wire, project } = await open(page, sample, student);

				await page.keyboard.press("Shift+Alt+F");
				await expect(editorLines(page, sample.path)).toContainText("# formatted");
				expect(wire.sentWith("textDocument/formatting", sample.formatter)).toHaveLength(
					1,
				);
				// Python format goes to ruff alone; the other servers are never asked.
				const others = (["python", "typescript", "ruff"] as const).filter(
					(id) => id !== sample.formatter,
				);
				for (const id of others) {
					expect(wire.sentWith("textDocument/formatting", id)).toHaveLength(0);
				}
				await expect
					.poll(
						async () => readSeededFile(student.workspaceId, project.slug, sample.path),
						{
							timeout: 20_000,
						},
					)
					.toMatch(/^# formatted\n/);
			});

			test("diagnostics appear as markers with the server's message", async ({
				page,
				context,
			}) => {
				const student = await createStudent(context);
				await open(page, sample, student);

				// Python's server pushes a warning; the TypeScript server is asked
				// and answers an error.
				const squiggle =
					sample.server === "python" ? ".squiggly-warning" : ".squiggly-error";
				await expect(
					page.getByTestId(`editor-${sample.path}`).locator(squiggle).first(),
				).toBeVisible({ timeout: 20_000 });
				await page
					.getByTestId(`editor-${sample.path}`)
					.locator(".view-line")
					.first()
					.hover({ position: { x: 2, y: 6 } });
				await expect(hoverWidget(page)).toContainText(
					sample.server === "python" ? "scripted warning" : "scripted error",
				);
			});

			test("only the servers for the file's language are started", async ({
				page,
				context,
			}) => {
				const student = await createStudent(context);
				const { wire } = await open(page, sample, student);

				const expected = new Set<LanguageServerId>([sample.server, sample.formatter]);
				for (const id of ["python", "typescript", "ruff"] as const) {
					expect(wire.opened(id), id).toBe(expected.has(id) ? 1 : 0);
				}
				// Ruff formats and nothing else, so it is never asked for the rest.
				for (const method of [
					"textDocument/completion",
					"textDocument/hover",
					"textDocument/definition",
					"textDocument/rename",
				]) {
					expect(wire.sentWith(method, "ruff")).toHaveLength(0);
				}
			});
		});
	}
});

test.describe("code help wire format", () => {
	test.describe.configure({ timeout: 120_000 });
	holdCodeHelpSwitch(test);

	test("positions are zero-based and count UTF-16 units", async ({ page, context }) => {
		const student = await createStudent(context);
		const wire = await watchLanguageServers(page);
		// Each line ends where the typed word is empty, so the suggestion list shows.
		const astral = "😀 = ";
		await openProjectFiles(page, student, "Positions", {
			"p.py": `x = 1\nab = 2\n${astral}\n`,
		});
		await expect(codeHelpStatus(page, "p.py")).toHaveText("Code help ready", {
			timeout: 60_000,
		});

		await editorLines(page, "p.py").click();
		await page.keyboard.press("Control+Home");
		await page.keyboard.press("ArrowDown");
		for (let step = 0; step < 3; step += 1) await page.keyboard.press("ArrowRight");
		await page.keyboard.press("Control+Space");
		await expect
			.poll(() => wire.sentWith("textDocument/completion", "python").length)
			.toBe(1);
		expect(
			wire.sentWith("textDocument/completion", "python")[0]?.message.params.position,
		).toEqual({
			line: 1,
			character: 3,
		});

		// Close the list only once it has shown, so the keys that follow move the cursor.
		await expect(page.locator(".suggest-widget")).toContainText("portikus_example");
		await page.keyboard.press("Escape");
		await expect(page.locator(".suggest-widget")).toBeHidden();
		await page.keyboard.press("ArrowDown");
		await page.keyboard.press("End");
		await page.keyboard.press("Control+Space");
		await expect
			.poll(() => wire.sentWith("textDocument/completion", "python").length)
			.toBe(2);
		expect(
			wire.sentWith("textDocument/completion", "python")[1]?.message.params.position,
		).toEqual({
			line: 2,
			character: astral.length,
		});
	});

	test("the client asks for no snippets and no file operations", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const wire = await watchLanguageServers(page);
		await openProjectFiles(page, student, "Capabilities", { "a.ts": "const a = 1;\n" });
		await expect(codeHelpStatus(page, "a.ts")).toHaveText("Code help ready", {
			timeout: 60_000,
		});

		const [initialize] = wire.sentWith("initialize", "typescript");
		const capabilities = initialize?.message.params.capabilities;
		expect(capabilities.textDocument.completion.completionItem.snippetSupport).toBe(
			false,
		);
		expect(capabilities.workspace.workspaceEdit.resourceOperations).toEqual([]);
		expect(capabilities.workspace.applyEdit).toBe(false);
		expect(wire.sentWith("initialized", "typescript")).toHaveLength(1);
	});

	test("an edit is sent as an incremental change to the open document", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const wire = await watchLanguageServers(page);
		const project = await openProjectFiles(page, student, "Incremental", {
			"a.ts": "const a = 1;\nconst b = 2;\n",
		});
		await expect(codeHelpStatus(page, "a.ts")).toHaveText("Code help ready", {
			timeout: 60_000,
		});
		const [opened] = wire.sentWith("textDocument/didOpen", "typescript");
		expect(opened?.message.params.textDocument).toMatchObject({
			uri: serverUriOf(project, "a.ts"),
			languageId: "typescript",
			text: "const a = 1;\nconst b = 2;\n",
		});

		await editorLines(page, "a.ts").click();
		await page.keyboard.press("Control+Home");
		await page.keyboard.press("ArrowDown");
		await page.keyboard.type("Q");
		await expect
			.poll(() => wire.sentWith("textDocument/didChange", "typescript").length)
			.toBeGreaterThan(0);
		const changed = wire.sentWith("textDocument/didChange", "typescript")[0]?.message
			.params;
		expect(changed.textDocument.uri).toBe(serverUriOf(project, "a.ts"));
		expect(changed.textDocument.version).toBeGreaterThan(
			opened?.message.params.textDocument.version,
		);
		expect(changed.contentChanges).toHaveLength(1);
		expect(changed.contentChanges[0]).toMatchObject({
			range: { start: { line: 1, character: 0 }, end: { line: 1, character: 0 } },
			text: "Q",
		});
	});
});
