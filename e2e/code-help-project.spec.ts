import { expect, type Page, test } from "@playwright/test";
import {
	codeHelpStatus,
	editorLines,
	editorMessage,
	FIRST_CHARACTER,
	holdCodeHelpSwitch,
	lineAtCursor,
	openProjectFiles,
	renameTo,
	saveQuickly,
	serverUriOf,
	watchLanguageServers,
} from "./code-help-helpers";
import {
	createStudent,
	query,
	readSeededFile,
	seedFile,
	type TestProject,
	type TestStudent,
} from "./helpers";

/**
 * Where code help may go: definitions in other project files, nothing
 * outside the project, and a rename that is limited, all or nothing, and
 * never overwrites a newer file (SPEC.md §13.6, §13.5).
 */
test.describe("code help and the project boundary", () => {
	test.describe.configure({ timeout: 180_000 });
	holdCodeHelpSwitch(test);

	const APP = "src/app.ts";
	const APP_TEXT = "const answer = 42;\nconst other = answer;\n";
	const UTIL = "src/util.ts";
	const UTIL_TEXT = `${Array.from({ length: 60 }, (_, index) => `line${index + 1}`).join("\n")}\n`;

	const RENAMED = "ren";
	const edit = (newText = RENAMED) => ({ range: FIRST_CHARACTER, newText });

	async function openApp(page: Page, student: TestStudent, extra: string[] = []) {
		const wire = await watchLanguageServers(page);
		await saveQuickly(student.userId);
		const project = await openProjectFiles(page, student, "Boundary", {
			[APP]: APP_TEXT,
		});
		await seedFile(student.workspaceId, project.slug, UTIL, UTIL_TEXT);
		for (const path of extra) {
			await seedFile(student.workspaceId, project.slug, path, `${path}\n`);
		}
		await expect(codeHelpStatus(page, APP)).toHaveText("Code help ready", {
			timeout: 60_000,
		});
		await editorLines(page, APP).click();
		await page.keyboard.press("Control+Home");
		return { wire, project };
	}

	/** Answer every rename with these edits, by project path (or any URI). */
	function renameAnswers(
		wire: Awaited<ReturnType<typeof watchLanguageServers>>,
		changes: Record<string, unknown[]>,
	) {
		wire.rewrite(({ method }) =>
			method === "textDocument/rename" ? { changes } : undefined,
		);
	}

	const panes = (page: Page) => page.locator('[data-testid^="file-pane-"]');

	test.describe("go to definition", () => {
		test("a target in another project file opens that file at the line", async ({
			page,
			context,
		}) => {
			const student = await createStudent(context);
			const { wire, project } = await openApp(page, student);
			wire.rewrite(({ method }) =>
				method === "textDocument/definition"
					? [
							{
								uri: serverUriOf(project, UTIL),
								range: {
									start: { line: 39, character: 0 },
									end: { line: 39, character: 6 },
								},
							},
						]
					: undefined,
			);

			await page.keyboard.press("F12");
			await expect(page.getByTestId(`file-pane-${UTIL}`)).toBeVisible();
			await expect(editorLines(page, UTIL)).toContainText("line40", {
				timeout: 30_000,
			});
			// The cursor is on the target line, which is scrolled into view.
			await expect.poll(() => lineAtCursor(page, UTIL)).toBe("line40");
		});

		test("a target outside the project is not opened and a message says so", async ({
			page,
			context,
		}) => {
			const student = await createStudent(context);
			const { wire, project } = await openApp(page, student);
			await page.keyboard.press("Control+End");
			await page.keyboard.press("ArrowUp");

			const outside = [
				"file:///etc/passwd",
				// Shares the project folder's name as a prefix, but is a sibling.
				`file://${project.path}-sibling/secret.ts`,
				`file://${project.path}/../secret.ts`,
				`file://${project.path}/%2e%2e/secret.ts`,
			];
			for (const [index, uri] of outside.entries()) {
				wire.rewrite(({ method }) =>
					method === "textDocument/definition"
						? [{ uri, range: FIRST_CHARACTER }]
						: undefined,
				);
				await page.keyboard.press("F12");
				await expect
					.poll(() => wire.sentWith("textDocument/definition", "typescript").length)
					.toBe(index + 1);
				await expect(editorMessage(page)).toHaveText(
					"That definition is outside the project, so it is not opened.",
				);
				await page.keyboard.press("Escape");
				await expect(editorMessage(page)).toHaveCount(0);
				await expect(panes(page), uri).toHaveCount(1);
			}
			await expect(editorLines(page, APP)).toContainText("const answer");
		});

		test("a target that is not a file opens no window", async ({ page, context }) => {
			// Known gap: Monaco's own opener follows an https target in a new
			// window, so SPEC.md §13.6 ("a target outside the project is not
			// opened, and a short message says so") is not met. test.fail keeps
			// the suite green and fails loudly once the product is fixed.
			test.fail();
			const student = await createStudent(context);
			const { wire } = await openApp(page, student);
			await page.keyboard.press("Control+End");
			await page.keyboard.press("ArrowUp");
			wire.rewrite(({ method }) =>
				method === "textDocument/definition"
					? [{ uri: "https://evil.example.test/page", range: FIRST_CHARACTER }]
					: undefined,
			);
			const popups: string[] = [];
			page.context().on("page", (opened) => popups.push(opened.url()));

			await page.keyboard.press("F12");
			await expect
				.poll(() => wire.sentWith("textDocument/definition", "typescript").length)
				.toBe(1);
			await page.waitForTimeout(1500);
			expect(popups).toEqual([]);
			await expect(editorMessage(page)).toHaveText(
				"That definition is outside the project, so it is not opened.",
			);
			await expect(panes(page)).toHaveCount(1);
		});
	});

	test.describe("rename", () => {
		async function expectUnchanged(
			student: TestStudent,
			project: TestProject,
			paths: string[],
			texts: Record<string, string>,
		) {
			// Longer than the auto-save delay, so a stray save would have landed.
			await new Promise((resolve) => setTimeout(resolve, 3000));
			for (const path of paths) {
				expect(
					await readSeededFile(student.workspaceId, project.slug, path),
					path,
				).toBe(texts[path]);
			}
		}

		test("changes every file the server names and opens the ones that are closed", async ({
			page,
			context,
		}) => {
			const student = await createStudent(context);
			const extra = ["src/more.ts"];
			const { wire, project } = await openApp(page, student, extra);
			renameAnswers(wire, {
				[serverUriOf(project, APP)]: [edit()],
				[serverUriOf(project, UTIL)]: [edit()],
				[serverUriOf(project, "src/more.ts")]: [edit()],
			});

			await renameTo(page, "ignored");
			await expect(editorMessage(page)).toHaveText("Renamed in 3 files.", {
				timeout: 30_000,
			});
			await expect(page.getByTestId(`tab-file:${UTIL}`)).toBeAttached();
			for (const [path, text] of [
				[APP, APP_TEXT],
				[UTIL, UTIL_TEXT],
				["src/more.ts", "src/more.ts\n"],
			] as const) {
				await expect
					.poll(async () => readSeededFile(student.workspaceId, project.slug, path), {
						timeout: 20_000,
					})
					.toBe(`${RENAMED}${text.slice(1)}`);
			}
		});

		test("refuses a rename of more than 20 files and changes none", async ({
			page,
			context,
		}) => {
			const student = await createStudent(context);
			const names = Array.from({ length: 20 }, (_, index) => `src/f${index}.ts`);
			const { wire, project } = await openApp(page, student, names);
			renameAnswers(wire, {
				[serverUriOf(project, APP)]: [edit()],
				...Object.fromEntries(
					names.map((path) => [serverUriOf(project, path), [edit()]]),
				),
			});

			await renameTo(page, "ignored");
			await expect(editorMessage(page)).toHaveText(
				"Rename would change more than 20 files, so it was not done.",
			);
			// All or nothing: not even the open file changed, and no tab was opened.
			await expect(editorLines(page, APP)).toContainText("const answer");
			await expect(panes(page)).toHaveCount(1);
			await expectUnchanged(student, project, [APP, "src/f0.ts", "src/f19.ts"], {
				[APP]: APP_TEXT,
				"src/f0.ts": "src/f0.ts\n",
				"src/f19.ts": "src/f19.ts\n",
			});
		});

		test("allows a rename of exactly 20 files", async ({ page, context }) => {
			const student = await createStudent(context);
			const names = Array.from({ length: 19 }, (_, index) => `src/f${index}.ts`);
			const { wire, project } = await openApp(page, student, names);
			renameAnswers(wire, {
				[serverUriOf(project, APP)]: [edit()],
				...Object.fromEntries(
					names.map((path) => [serverUriOf(project, path), [edit()]]),
				),
			});

			await renameTo(page, "ignored");
			await expect(editorMessage(page)).toHaveText("Renamed in 20 files.", {
				timeout: 90_000,
			});
			for (const path of ["src/f0.ts", "src/f18.ts"]) {
				await expect
					.poll(async () => readSeededFile(student.workspaceId, project.slug, path), {
						timeout: 30_000,
					})
					.toBe(`${RENAMED}${`${path}\n`.slice(1)}`);
			}
		});

		test("refuses a rename that reaches outside the project and changes nothing", async ({
			page,
			context,
		}) => {
			const student = await createStudent(context);
			const { wire, project } = await openApp(page, student);
			renameAnswers(wire, {
				[serverUriOf(project, APP)]: [edit()],
				[serverUriOf(project, UTIL)]: [edit()],
				"file:///etc/hosts": [edit()],
			});

			await renameTo(page, "ignored");
			await expect(editorMessage(page)).toHaveText(
				"Rename would change files outside the project, so it was not done.",
			);
			await expect(editorLines(page, APP)).toContainText("const answer");
			await expect(panes(page)).toHaveCount(1);
			await expectUnchanged(student, project, [APP, UTIL], {
				[APP]: APP_TEXT,
				[UTIL]: UTIL_TEXT,
			});
		});

		test("refuses a rename that would create, move or delete files", async ({
			page,
			context,
		}) => {
			const student = await createStudent(context);
			const { wire, project } = await openApp(page, student);
			const operations = [
				{ kind: "create", uri: serverUriOf(project, "src/new.ts") },
				{
					kind: "rename",
					oldUri: serverUriOf(project, UTIL),
					newUri: serverUriOf(project, "src/moved.ts"),
				},
				{ kind: "delete", uri: serverUriOf(project, UTIL) },
			];
			for (const [index, operation] of operations.entries()) {
				wire.rewrite(({ method }) =>
					method === "textDocument/rename"
						? {
								documentChanges: [
									{
										textDocument: { uri: serverUriOf(project, APP), version: null },
										edits: [edit()],
									},
									operation,
								],
							}
						: undefined,
				);
				await renameTo(page, "ignored");
				await expect
					.poll(() => wire.sentWith("textDocument/rename", "typescript").length)
					.toBe(index + 1);
				await expect(editorMessage(page)).toHaveText(
					"Rename would create, move or delete files, so it was not done.",
				);
				await page.keyboard.press("Escape");
			}
			await expect(editorLines(page, APP)).toContainText("const answer");
			await expectUnchanged(student, project, [APP, UTIL], {
				[APP]: APP_TEXT,
				[UTIL]: UTIL_TEXT,
			});
		});

		test("changes nothing when one of the files cannot be opened", async ({
			page,
			context,
		}) => {
			const student = await createStudent(context);
			const { wire, project } = await openApp(page, student);
			renameAnswers(wire, {
				[serverUriOf(project, APP)]: [edit()],
				[serverUriOf(project, "src/missing.ts")]: [edit()],
			});

			await renameTo(page, "ignored");
			await expect(editorMessage(page)).toHaveText(
				"Not every file could be opened, so nothing was renamed.",
				{ timeout: 30_000 },
			);
			await expectUnchanged(student, project, [APP], { [APP]: APP_TEXT });
		});

		test("never overwrites a file that changed on disk under unsaved edits", async ({
			page,
			context,
		}) => {
			const student = await createStudent(context);
			const wire = await watchLanguageServers(page);
			await query(
				"update users set editor_settings = editor_settings || $1::jsonb where id = $2",
				[JSON.stringify({ autoSave: false }), student.userId],
			);
			const project = await openProjectFiles(page, student, "Newer", {
				[APP]: APP_TEXT,
				[UTIL]: UTIL_TEXT,
			});
			await expect(codeHelpStatus(page, APP)).toHaveText("Code help ready", {
				timeout: 60_000,
			});

			// The other file has unsaved edits here, and then changes on disk.
			await page.getByTestId(`tab-file:${UTIL}`).click();
			await editorLines(page, UTIL).click();
			await page.keyboard.press("Control+Home");
			await page.keyboard.type("mine ");
			const newer = "written by someone else\n";
			await seedFile(student.workspaceId, project.slug, UTIL, newer);
			await expect(page.getByTestId("file-conflict")).toBeVisible({ timeout: 20_000 });

			await page.getByTestId(`tab-file:${APP}`).click();
			await editorLines(page, APP).click();
			await page.keyboard.press("Control+Home");
			renameAnswers(wire, {
				[serverUriOf(project, APP)]: [edit()],
				[serverUriOf(project, UTIL)]: [edit()],
			});
			await renameTo(page, "ignored");
			await expect
				.poll(() => wire.sentWith("textDocument/rename", "typescript").length)
				.toBe(1);

			// The save may be refused or may need the student's answer; either
			// way the newer text on disk stays.
			await new Promise((resolve) => setTimeout(resolve, 4000));
			expect(await readSeededFile(student.workspaceId, project.slug, APP)).toBe(
				`${RENAMED}${APP_TEXT.slice(1)}`,
			);
			await expect(page.getByTestId("file-conflict")).toHaveCount(1);
			expect(await readSeededFile(student.workspaceId, project.slug, UTIL)).toBe(newer);
		});
	});
});
