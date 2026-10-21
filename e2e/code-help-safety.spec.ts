import { expect, type Page, test } from "@playwright/test";
import {
	codeHelpStatus,
	editorLines,
	FIRST_CHARACTER,
	holdCodeHelpSwitch,
	hoverWidget,
	openProjectFiles,
	saveQuickly,
	serverUriOf,
	watchLanguageServers,
} from "./code-help-helpers";
import {
	createProject,
	createStudent,
	query,
	readSeededFile,
	seedGit,
	workspacePath,
} from "./helpers";

/**
 * What the browser must refuse from a language server, and the size limit
 * (SPEC.md §13.6, §24.1, §24.3). The server's text can come from a docstring in
 * a file the student copied, so it is never trusted.
 */
test.describe("code help refuses what a server must not do", () => {
	test.describe.configure({ timeout: 120_000 });
	holdCodeHelpSwitch(test);

	const PATH = "src/app.ts";
	const CONTENT = "const answer = 42;\nconst other = answer;\n";
	const IMAGES = "https://images.example.test";
	const DOCS = "https://docs.example.test/page";

	/** Markup that would run code, open a window or load an image if it were trusted. */
	const HOSTILE = [
		`<img src="${IMAGES}/html.png" onerror="window.__pwned = 'img'">`,
		"<b>html bold</b> <script>window.__pwned = 'script'</script>",
		`[web link](${DOCS}) [script link](javascript:window.__pwned='js')`,
		"[command link](command:workbench.action.reloadWindow) [file link](file:///etc/passwd)",
		`![remote image](${IMAGES}/md.png)`,
		"[reference link][bad]",
		"[bad]: javascript:window.__pwned='reference'",
	].join("\n\n");

	async function openTs(page: Page, content = CONTENT) {
		const student = await createStudent(page.context());
		const wire = await watchLanguageServers(page);
		await saveQuickly(student.userId);
		const project = await openProjectFiles(page, student, "Safety", {
			[PATH]: content,
		});
		await expect(editorLines(page, PATH)).toContainText("const", { timeout: 60_000 });
		return { student, wire, project };
	}

	async function ready(page: Page) {
		await expect(codeHelpStatus(page, PATH)).toHaveText("Code help ready", {
			timeout: 30_000,
		});
	}

	/** Every request for an image from the server's host, which nothing may make. */
	async function watchImages(page: Page): Promise<string[]> {
		const hits: string[] = [];
		await page.route(/images\.example\.test/, async (route) => {
			hits.push(route.request().url());
			await route.abort();
		});
		return hits;
	}

	/** What a hover or suggestion panel holds, once it is on screen. */
	function inspect(panel: ReturnType<typeof hoverWidget>) {
		return panel.evaluate((element) => ({
			// An anchor with no target is one of Monaco's own buttons.
			hrefs: [...element.querySelectorAll("a")]
				.map((link) => link.getAttribute("href") ?? link.getAttribute("data-href"))
				.filter((href): href is string => href !== null),
			images: element.querySelectorAll("img, svg image").length,
			active: element.querySelectorAll("script, iframe, object, embed").length,
			bold: element.querySelectorAll("b").length,
			text: element.textContent ?? "",
		}));
	}

	function expectSafe(shown: Awaited<ReturnType<typeof inspect>>) {
		expect(shown.images).toBe(0);
		expect(shown.active).toBe(0);
		expect(shown.bold).toBe(0);
		// Only the web link survives as a link, and only because it is http(s).
		for (const href of shown.hrefs) expect(href).toMatch(/^https?:\/\//);
		expect(shown.hrefs).toContain(DOCS);
		// What was dropped is still readable as text, not hidden.
		expect(shown.text).toContain("script link");
		expect(shown.text).toContain("command link");
		expect(shown.text).toContain("html bold");
	}

	async function expectNothingRan(page: Page, images: string[]) {
		expect(images).toEqual([]);
		expect(
			await page.evaluate(() => (window as { __pwned?: string }).__pwned),
		).toBeUndefined();
	}

	test("hover text is rendered as text with only web links and no images", async ({
		page,
	}) => {
		const images = await watchImages(page);
		const { wire } = await openTs(page);
		wire.rewrite(({ method }) =>
			method === "textDocument/hover"
				? { contents: { kind: "markdown", value: HOSTILE }, range: FIRST_CHARACTER }
				: undefined,
		);
		await ready(page);

		await page
			.getByTestId(`editor-${PATH}`)
			.locator(".view-line")
			.first()
			.hover({ position: { x: 2, y: 6 } });
		await expect(hoverWidget(page)).toContainText("web link");
		expectSafe(await inspect(hoverWidget(page)));
		await page.waitForTimeout(1000);
		await expectNothingRan(page, images);
	});

	test("a web link in a hover opens in a window that cannot reach the page", async ({
		page,
		context,
	}) => {
		await context.route(DOCS, (route) =>
			route.fulfill({ contentType: "text/html", body: "<title>docs</title>docs" }),
		);
		const { wire } = await openTs(page);
		wire.rewrite(({ method }) =>
			method === "textDocument/hover"
				? {
						contents: { kind: "markdown", value: `[web link](${DOCS})` },
						range: FIRST_CHARACTER,
					}
				: undefined,
		);
		await ready(page);
		await page
			.getByTestId(`editor-${PATH}`)
			.locator(".view-line")
			.first()
			.hover({ position: { x: 2, y: 6 } });

		const popup = page.waitForEvent("popup");
		await hoverWidget(page).getByText("web link").click();
		const opened = await popup;
		await opened.waitForLoadState();
		expect(opened.url()).toBe(DOCS);
		expect(await opened.evaluate(() => window.opener)).toBeNull();
	});

	test("plain text and code-block hovers show no links or images either", async ({
		page,
	}) => {
		const images = await watchImages(page);
		const { wire } = await openTs(page);
		await ready(page);
		await page
			.getByTestId(`editor-${PATH}`)
			.locator(".view-line")
			.first()
			.hover({ position: { x: 2, y: 6 } });
		await expect(hoverWidget(page)).toContainText("scripted hover");

		for (const [contents, shownText] of [
			[
				{ kind: "plaintext", value: `<img src="${IMAGES}/a.png"> [t](${DOCS}) **b**` },
				"**b**",
			],
			[
				[{ language: "typescript", value: `<img src="${IMAGES}/b.png"> [t](${DOCS})` }],
				"[t](",
			],
			[`<img src="${IMAGES}/c.png"> plain string`, "plain string"],
		] as const) {
			wire.rewrite(({ method }) =>
				method === "textDocument/hover"
					? { contents, range: FIRST_CHARACTER }
					: undefined,
			);
			await page.mouse.move(600, 400);
			await expect(hoverWidget(page)).toHaveCount(0);
			await page
				.getByTestId(`editor-${PATH}`)
				.locator(".view-line")
				.first()
				.hover({ position: { x: 2, y: 6 } });
			await expect(hoverWidget(page)).toContainText(shownText);
			const shown = await inspect(hoverWidget(page));
			expect(shown.images).toBe(0);
			expect(shown.active).toBe(0);
			// A bare web address in the text may become a link; it is still http(s).
			for (const href of shown.hrefs) expect(href).toMatch(/^https?:\/\//);
			expect(shown.text).not.toContain("scripted hover");
		}
		await expectNothingRan(page, images);
	});

	test("completion text is rendered as text with only web links and no images", async ({
		page,
	}) => {
		const images = await watchImages(page);
		const { wire } = await openTs(page);
		wire.rewrite(({ method }) =>
			method === "textDocument/completion"
				? {
						isIncomplete: false,
						items: [
							{
								label: "hostile_item",
								kind: 3,
								detail: `<img src="${IMAGES}/detail.png" onerror="window.__pwned = 'detail'">`,
								documentation: { kind: "markdown", value: HOSTILE },
							},
						],
					}
				: undefined,
		);
		await ready(page);

		await editorLines(page, PATH).click();
		await page.keyboard.press("Control+Home");
		await page.keyboard.press("Control+Space");
		const widget = page.locator(".suggest-widget:not(.hidden)");
		await expect(widget).toContainText("hostile_item");
		// A second press opens the documentation beside the list.
		await page.keyboard.press("Control+Space");
		const details = page.locator(".suggest-details");
		await expect(details).toContainText("web link");
		expectSafe(await inspect(details));
		const suggestion = await inspect(widget);
		expect(suggestion.images).toBe(0);
		expect(suggestion.active).toBe(0);
		await page.waitForTimeout(1000);
		await expectNothingRan(page, images);
	});

	test("requests the client must decline are declined and change nothing", async ({
		page,
	}) => {
		const { student, wire, project } = await openTs(page);
		await ready(page);

		wire.push("typescript", {
			id: 9001,
			method: "workspace/applyEdit",
			params: {
				edit: {
					changes: {
						[serverUriOf(project, PATH)]: [
							{ range: FIRST_CHARACTER, newText: "HACKED" },
						],
					},
				},
			},
		});
		wire.push("typescript", {
			id: 9002,
			method: "window/showDocument",
			params: { uri: serverUriOf(project, "src/secret.ts"), takeFocus: true },
		});
		wire.push("typescript", {
			id: 9003,
			method: "workspace/executeCommand",
			params: { command: "editor.action.reboot", arguments: [] },
		});
		const answer = (id: number) =>
			wire.sent.find(
				(item) => item.message.id === id && item.message.method === undefined,
			)?.message;
		await expect.poll(() => answer(9003)).toBeDefined();
		await expect.poll(() => answer(9002)).toBeDefined();
		await expect.poll(() => answer(9001)).toBeDefined();

		expect(answer(9001)?.result).toEqual({
			applied: false,
			failureReason: "Not supported",
		});
		expect(answer(9002)?.result).toEqual({ success: false });
		expect(answer(9003)?.result).toBeUndefined();
		expect(answer(9003)?.error).toBeDefined();

		// Nothing was edited and no file was opened on the server's say-so.
		await expect(editorLines(page, PATH)).not.toContainText("HACKED");
		await expect(page.locator('[data-testid^="file-pane-"]')).toHaveCount(1);
		await page.waitForTimeout(2500);
		expect(await readSeededFile(student.workspaceId, project.slug, PATH)).toBe(CONTENT);
	});
});

test.describe("code help and large files", () => {
	test.describe.configure({ timeout: 180_000 });
	holdCodeHelpSwitch(test);

	const PATH = "big.ts";
	const TOO_LARGE = "Code help is off for files over 512 KB";
	const LIMIT = 512 * 1024;
	/** 64 bytes a line, so a whole number of lines fills the limit exactly. */
	const LINE = `${"a".repeat(63)}\n`;
	const AT_LIMIT = LINE.repeat(LIMIT / 64);

	async function openBig(page: Page, content: string) {
		const student = await createStudent(page.context());
		const wire = await watchLanguageServers(page);
		await saveQuickly(student.userId);
		const project = await openProjectFiles(page, student, "Large", { [PATH]: content });
		await expect(editorLines(page, PATH)).toContainText(content.slice(0, 4), {
			timeout: 60_000,
		});
		return { student, wire, project };
	}

	test("a file of exactly 512 KiB is sent", async ({ page }) => {
		expect(new TextEncoder().encode(AT_LIMIT).length).toBe(LIMIT);
		const { wire, project } = await openBig(page, AT_LIMIT);
		await expect(codeHelpStatus(page, PATH)).toHaveText("Code help ready", {
			timeout: 30_000,
		});
		const [opened] = wire.sentWith("textDocument/didOpen", "typescript");
		expect(opened?.message.params.textDocument.uri).toBe(serverUriOf(project, PATH));
	});

	for (const [name, content] of [
		["one byte over 512 KiB", `${AT_LIMIT}b`],
		// Fewer than 512 Ki characters, but more than 512 KiB once encoded.
		["multi-byte text over 512 KiB", `${"é".repeat(31)}\n`.repeat(9000)],
	] as const) {
		test(`${name} is not sent, says so, and still edits`, async ({ page }) => {
			const { student, wire, project } = await openBig(page, content);
			await expect(codeHelpStatus(page, PATH)).toHaveText(TOO_LARGE, {
				timeout: 30_000,
			});

			await editorLines(page, PATH).click();
			await page.keyboard.press("Control+Home");
			await page.keyboard.type("// ");
			await page.keyboard.press("Control+Space");
			await page
				.getByTestId(`editor-${PATH}`)
				.locator(".view-line")
				.first()
				.hover({ position: { x: 2, y: 6 } });
			await expect
				.poll(async () => readSeededFile(student.workspaceId, project.slug, PATH), {
					timeout: 30_000,
				})
				.toMatch(/^\/\/ /);

			for (const method of [
				"textDocument/didOpen",
				"textDocument/didChange",
				"textDocument/completion",
				"textDocument/hover",
			]) {
				expect(wire.sentWith(method), method).toHaveLength(0);
			}
			await expect(codeHelpStatus(page, PATH)).toHaveText(TOO_LARGE);
		});
	}

	test("a file that grows past the limit is closed on the server, and reopens when it shrinks", async ({
		page,
	}) => {
		const { wire } = await openBig(page, AT_LIMIT.slice(0, -4));
		await expect(codeHelpStatus(page, PATH)).toHaveText("Code help ready", {
			timeout: 30_000,
		});

		await editorLines(page, PATH).click();
		await page.keyboard.press("Control+End");
		await page.keyboard.type("abcdef");
		await expect(codeHelpStatus(page, PATH)).toHaveText(TOO_LARGE, { timeout: 30_000 });
		await expect.poll(() => wire.sentWith("textDocument/didClose").length).toBe(1);

		await page.keyboard.press("Control+a");
		await page.keyboard.press("Delete");
		await page.keyboard.type("aaaa");
		await expect(codeHelpStatus(page, PATH)).toHaveText("Code help ready", {
			timeout: 30_000,
		});
		await expect.poll(() => wire.sentWith("textDocument/didOpen").length).toBe(2);
	});
});

test.describe("code help and text that is not a project file", () => {
	test.describe.configure({ timeout: 120_000 });
	holdCodeHelpSwitch(test);

	test("a diff tab opens no language-server socket", async ({ page, context }) => {
		const student = await createStudent(context);
		const wire = await watchLanguageServers(page);
		const path = "src/app.ts";
		const project = await createProject(student.workspaceId, { name: "Diff only" });
		await seedGit(student.workspaceId, project.slug, {
			diffs: {
				[path]: {
					status: "M",
					before: "const answer = 1;\n",
					after: "const answer = 42;\n",
					binary: false,
					tooLarge: false,
				},
			},
		});
		await query("update projects set layout = $2 where id = $1", [
			project.id,
			JSON.stringify({ tabs: [{ id: `diff:${path}`, root: { type: "diff", path } }] }),
		]);
		await page.goto(workspacePath(student.workspaceId, project.id));
		await expect(
			page.getByTestId(`diff-editor-${path}`).locator(".monaco-diff-editor"),
		).toBeVisible({
			timeout: 60_000,
		});
		await expect(page.getByTestId(`diff-editor-${path}`)).toContainText(
			"const answer = 42;",
		);

		await page.waitForTimeout(3000);
		for (const id of ["python", "typescript", "ruff"] as const) {
			expect(wire.opened(id), id).toBe(0);
		}
		expect(wire.sent).toHaveLength(0);
	});
});
