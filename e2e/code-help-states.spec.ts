import { expect, type Page, test } from "@playwright/test";
import {
	codeHelpLiveRegion,
	codeHelpStatus,
	DROP,
	editorLines,
	holdCodeHelpSwitch,
	openProjectFiles,
	saveQuickly,
	watchLanguageServers,
} from "./code-help-helpers";
import {
	CODE_HELP_ALL_LANGUAGES,
	createProject,
	createStudent,
	query,
	readSeededFile,
	routeApi,
	seedFile,
	type TestStudent,
	workspacePath,
} from "./helpers";
import { FAKE_AGENT_URL } from "./ports";

/**
 * What a student sees when a language server stops, is replaced, or is
 * turned off, and that editing never waits for any of it (SPEC.md §13.6).
 */

const PATH = "app.py";
const CONTENT = "answer = 42\n";
const OUT_OF_MEMORY = "crashed: may have run out of memory";

async function openPython(page: Page, student: TestStudent) {
	const wire = await watchLanguageServers(page);
	await saveQuickly(student.userId);
	const project = await openProjectFiles(page, student, "States", { [PATH]: CONTENT });
	await expect(editorLines(page, PATH)).toContainText("answer", { timeout: 60_000 });
	return { wire, project };
}

async function ready(page: Page) {
	await expect(codeHelpStatus(page, PATH)).toHaveText("Code help ready", {
		timeout: 30_000,
	});
}

const button = (page: Page, name: string) =>
	page.getByRole("button", { name, exact: true });

/** Type at the end of the file and wait for it to reach the disk. */
async function typeAndSave(
	page: Page,
	student: TestStudent,
	slug: string,
	text: string,
) {
	await editorLines(page, PATH).click();
	await page.keyboard.press("Control+End");
	await page.keyboard.type(text);
	await expect(editorLines(page, PATH)).toContainText(text);
	await expect
		.poll(async () => readSeededFile(student.workspaceId, slug, PATH), {
			timeout: 20_000,
		})
		.toContain(text);
}

/** Long enough for the client's first retry (one second) to have happened. */
const RETRY_WINDOW_MS = 2500;

async function windowFocus(page: Page) {
	await page.evaluate(() => window.dispatchEvent(new Event("focus")));
}

/** What the browser fires when the student comes back to the window; settings are read again. */
async function windowVisible(page: Page) {
	await page.evaluate(() => window.dispatchEvent(new Event("visibilitychange")));
}

/** Open a project whose one tab holds these files side by side. */
async function openSplit(
	page: Page,
	student: TestStudent,
	name: string,
	files: Record<string, string>,
) {
	const project = await createProject(student.workspaceId, { name });
	const paths = Object.keys(files);
	for (const path of paths) {
		await seedFile(student.workspaceId, project.slug, path, files[path] ?? "");
	}
	await query("update projects set layout = $2 where id = $1", [
		project.id,
		JSON.stringify({
			tabs: [
				{
					id: "side-by-side",
					root: {
						type: "split",
						direction: "row",
						sizes: paths.map(() => 100 / paths.length),
						children: paths.map((path) => ({ type: "file", path })),
					},
				},
			],
		}),
	]);
	await page.goto(workspacePath(student.workspaceId, project.id));
	for (const path of paths) {
		await expect(editorLines(page, path)).toBeVisible({ timeout: 60_000 });
	}
	return project;
}

test.describe("code help when the server stops", () => {
	test.describe.configure({ timeout: 120_000 });
	holdCodeHelpSwitch(test);

	test("replaced shows Use here and does not reconnect by itself", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const { wire, project } = await openPython(page, student);
		await ready(page);

		await wire.close("python", 4412, "replaced by another window");
		const status = codeHelpStatus(page, PATH);
		await expect(status).toHaveText("Code help is on in another window");
		await expect(button(page, "Use here")).toBeVisible();
		await expect(button(page, "Restart code help")).toHaveCount(0);

		// Waiting, editing and refocusing the window do not take the server back.
		await page.waitForTimeout(RETRY_WINDOW_MS);
		await typeAndSave(page, student, project.slug, "x");
		await windowFocus(page);
		await page.waitForTimeout(RETRY_WINDOW_MS);
		expect(wire.opened("python")).toBe(1);
		await expect(status).toHaveText("Code help is on in another window");

		await button(page, "Use here").click();
		await ready(page);
		expect(wire.opened("python")).toBe(2);
		await expect(button(page, "Use here")).toHaveCount(0);
		// The new socket starts from the document as it is now.
		const reopened = wire
			.sentWith("textDocument/didOpen", "python")
			.filter((frame) => frame.attempt === 1);
		expect(reopened).toHaveLength(1);
		expect(reopened[0]?.message.params.textDocument.text).toBe(`${CONTENT}x`);
	});

	test("idle shows nothing and the next edit reconnects", async ({ page, context }) => {
		const student = await createStudent(context);
		const { wire, project } = await openPython(page, student);
		await ready(page);

		await wire.close("python", 4413, "idle");
		await expect(codeHelpStatus(page, PATH)).toHaveText("");
		await expect(button(page, "Restart code help")).toHaveCount(0);
		await expect(button(page, "Use here")).toHaveCount(0);
		await page.waitForTimeout(RETRY_WINDOW_MS);
		expect(wire.opened("python")).toBe(1);

		await typeAndSave(page, student, project.slug, "y");
		await ready(page);
		expect(wire.opened("python")).toBe(2);
	});

	test("idle reconnects when the window gets focus", async ({ page, context }) => {
		const student = await createStudent(context);
		const { wire } = await openPython(page, student);
		await ready(page);

		await wire.close("python", 4413, "idle");
		await expect(codeHelpStatus(page, PATH)).toHaveText("");
		await windowFocus(page);
		await ready(page);
		expect(wire.opened("python")).toBe(2);
	});

	test("crashed shows the crash with Restart, and no memory wording by default", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const { wire } = await openPython(page, student);
		await ready(page);

		await wire.close("python", 4414, "crashed");
		const status = codeHelpStatus(page, PATH);
		await expect(status).toHaveText("Code help stopped");
		await expect(status).not.toContainText("memory");
		await expect(button(page, "Restart code help")).toBeVisible();
		await page.waitForTimeout(RETRY_WINDOW_MS);
		expect(wire.opened("python")).toBe(1);

		await button(page, "Restart code help").click();
		await ready(page);
		expect(wire.opened("python")).toBe(2);
		await expect(button(page, "Restart code help")).toHaveCount(0);
	});

	test("the memory wording appears only for the exact out-of-memory reason", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const { wire } = await openPython(page, student);
		await ready(page);
		const status = codeHelpStatus(page, PATH);

		const lookalikes = [
			`${OUT_OF_MEMORY}.`,
			OUT_OF_MEMORY.toUpperCase(),
			`${OUT_OF_MEMORY} `,
			"may have run out of memory",
			"out of memory",
			"crashed",
			"",
		];
		for (const reason of lookalikes) {
			await wire.close("python", 4414, reason);
			await expect(status, JSON.stringify(reason)).toHaveText("Code help stopped");
			await button(page, "Restart code help").click();
			await ready(page);
		}

		await wire.close("python", 4414, OUT_OF_MEMORY);
		await expect(status).toHaveText(
			"Code help stopped. It may have run out of memory.",
		);
		await expect(button(page, "Restart code help")).toBeVisible();
		// The words come from the client, not from the reason text.
		await expect(status).not.toContainText(OUT_OF_MEMORY);
	});

	test("unavailable turns the features off and offers Restart", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const { wire, project } = await openPython(page, student);
		await ready(page);

		await wire.close("python", 4415, "unavailable");
		await expect(codeHelpStatus(page, PATH)).toHaveText("Code help unavailable");
		await expect(button(page, "Restart code help")).toBeVisible();

		await editorLines(page, PATH).click();
		await page.keyboard.press("Control+Home");
		await page.keyboard.press("Control+Space");
		await page.waitForTimeout(1000);
		await expect(page.locator(".suggest-widget")).not.toContainText("portikus_example");
		await page
			.getByTestId(`editor-${PATH}`)
			.locator(".view-line")
			.first()
			.hover({ position: { x: 2, y: 6 } });
		await page.waitForTimeout(1000);
		await expect(page.locator(".monaco-hover:not(.hidden)")).toHaveCount(0);
		expect(wire.sentWith("textDocument/completion", "python")).toHaveLength(0);
		expect(wire.sentWith("textDocument/hover", "python")).toHaveLength(0);

		await typeAndSave(page, student, project.slug, "z");
		await page.waitForTimeout(RETRY_WINDOW_MS);
		expect(wire.opened("python")).toBe(1);

		await button(page, "Restart code help").click();
		await ready(page);
	});

	test("an ordinary close is retried by the client on its own", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const { wire } = await openPython(page, student);
		await ready(page);

		await wire.close("python", 1011, "agent closed");
		await expect.poll(() => wire.opened("python"), { timeout: 15_000 }).toBe(2);
		await ready(page);
	});

	for (const [name, code, text] of [
		["crashed", 4414, "Code help stopped"],
		["replaced", 4412, "Code help is on in another window"],
	] as const) {
		test(`two editors side by side announce ${name} once`, async ({
			page,
			context,
		}) => {
			const student = await createStudent(context);
			const wire = await watchLanguageServers(page);
			await saveQuickly(student.userId);
			await openSplit(page, student, "Side by side", {
				"one.py": CONTENT,
				"two.py": CONTENT,
			});
			for (const path of ["one.py", "two.py"]) {
				await expect(codeHelpStatus(page, path)).toHaveText("Code help ready", {
					timeout: 30_000,
				});
			}

			await wire.close("python", code, name);
			// Both bars say it, so each editor shows its own state.
			for (const path of ["one.py", "two.py"]) {
				await expect(codeHelpStatus(page, path)).toContainText(text);
			}
			// One live region carries the words, so a screen reader hears them once.
			await expect(page.getByRole("status").filter({ hasText: text })).toHaveCount(1);
			const spoken = await Promise.all(
				["one.py", "two.py"].map((path) =>
					codeHelpLiveRegion(page, path).textContent(),
				),
			);
			expect(spoken.sort()).toEqual(["", text]);
		});
	}

	test("a crash is announced by the editor on screen, not by one in a background tab", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const wire = await watchLanguageServers(page);
		await saveQuickly(student.userId);
		await openProjectFiles(page, student, "Background tab", {
			"one.py": CONTENT,
			"two.py": CONTENT,
		});
		await expect(editorLines(page, "one.py")).toBeVisible({ timeout: 60_000 });
		// one.py opened first; two.py comes to the front and one.py is hidden.
		await page.getByRole("tab", { name: /two\.py/ }).click();
		await expect(editorLines(page, "two.py")).toBeVisible({ timeout: 60_000 });
		await expect(page.getByTestId("terminal-group-file:one.py")).toBeHidden();
		for (const path of ["one.py", "two.py"]) {
			await expect(codeHelpStatus(page, path)).toHaveText("Code help ready", {
				timeout: 30_000,
			});
		}

		await wire.close("python", 4414, "crashed");
		// A screen reader ignores a live region in hidden content, so the words
		// must be in the one that is on screen.
		await expect(codeHelpLiveRegion(page, "two.py")).toHaveText("Code help stopped");
		await expect(codeHelpStatus(page, "one.py").locator("[role=status]")).toHaveText(
			"",
		);
	});

	test("disabled shows nothing and is never retried", async ({ page, context }) => {
		const student = await createStudent(context);
		const { wire, project } = await openPython(page, student);
		await ready(page);

		await wire.closeAll(4416, "code help is off");
		const status = codeHelpStatus(page, PATH);
		await expect(status).toHaveCount(0);
		await expect(button(page, "Restart code help")).toHaveCount(0);
		await expect(button(page, "Use here")).toHaveCount(0);

		// Not on a timer, not on an edit, and not when the window is focused.
		await typeAndSave(page, student, project.slug, "q");
		await windowFocus(page);
		await page.waitForTimeout(RETRY_WINDOW_MS + 1000);
		expect(wire.opened("python")).toBe(1);
		expect(wire.opened("ruff")).toBe(1);
		await expect(status).toHaveCount(0);
	});
});

test.describe("editing never waits for code help", () => {
	test.describe.configure({ timeout: 120_000 });
	holdCodeHelpSwitch(test);

	test("while the server is still starting", async ({ page, context }) => {
		const student = await createStudent(context);
		const wire = await watchLanguageServers(page, ({ method }) =>
			method === "initialize" ? DROP : undefined,
		);
		await saveQuickly(student.userId);
		const project = await openProjectFiles(page, student, "Starting", {
			[PATH]: CONTENT,
		});
		await expect(codeHelpStatus(page, PATH)).toHaveText("Code help starting…", {
			timeout: 60_000,
		});

		await typeAndSave(page, student, project.slug, "s");
		await expect(codeHelpStatus(page, PATH)).toHaveText("Code help starting…");
		expect(wire.sentWith("textDocument/didOpen")).toHaveLength(0);
	});

	for (const [name, code, text] of [
		["crashed", 4414, "Code help stopped"],
		["unavailable", 4415, "Code help unavailable"],
		["replaced", 4412, "Code help is on in another window"],
	] as const) {
		test(`while the server is ${name}`, async ({ page, context }) => {
			const student = await createStudent(context);
			const { wire, project } = await openPython(page, student);
			await ready(page);
			await wire.close("python", code, name);
			await expect(codeHelpStatus(page, PATH)).toHaveText(text);

			// The text is on screen at once and reaches the disk through auto-save.
			await typeAndSave(page, student, project.slug, "keeps typing");
		});
	}
});

test.describe("code help switched off for the site", () => {
	test.describe.configure({ timeout: 120_000 });
	holdCodeHelpSwitch(test);

	/** The settings the page reads, with code help on for the languages given. */
	async function stubLanguages(page: Page, codeHelpLanguages: string[]) {
		await routeApi(page, "**/me/settings", async (route, request) => {
			if (request.method() !== "GET") return route.fallback();
			const response = await route.fetch();
			const body = (await response.json()) as Record<string, unknown>;
			return route.fulfill({ response, json: { ...body, codeHelpLanguages } });
		});
	}

	test("off means no socket, no status, no Problems tab and a plain editor", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		await stubLanguages(page, []);
		const { wire, project } = await openPython(page, student);

		await page.waitForTimeout(RETRY_WINDOW_MS + 1000);
		expect(wire.opened("python")).toBe(0);
		expect(wire.opened("ruff")).toBe(0);
		await expect(page.getByTestId(`editor-code-help-${PATH}`)).toHaveCount(0);
		await expect(page.getByRole("tab", { name: "Problems" })).toHaveCount(0);

		// The plain editor still edits and saves, and offers no server suggestions.
		await typeAndSave(page, student, project.slug, "p");
		await page.keyboard.press("Control+Space");
		await page.waitForTimeout(1000);
		await expect(page.locator(".suggest-widget")).not.toContainText("portikus_example");
		expect(wire.sent).toHaveLength(0);

		// With the switch on again, the next page load has code help.
		await page.unroute("**/me/settings");
		await page.reload();
		await expect(editorLines(page, PATH)).toContainText("answer", { timeout: 60_000 });
		await ready(page);
	});
});

/** The tests that change the one site switch run alone (SPEC.md §13.6). */
test.describe("code help and the site switch", () => {
	test.describe.configure({ timeout: 180_000 });
	holdCodeHelpSwitch(test, { alone: true });

	async function setLanguages(languages: string) {
		await query("update settings set code_help_languages = $1 where id = 1", [
			languages,
		]);
	}

	test.beforeEach(async () => setLanguages(CODE_HELP_ALL_LANGUAGES));

	test("the API refuses the socket with DISABLED and the browser never retries", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		await setLanguages("{}");
		// The real settings say the switch is off.
		await page.goto("/");
		const real = await page.request.get("/me/settings");
		expect(
			((await real.json()) as { codeHelpLanguages: string[] }).codeHelpLanguages,
		).toEqual([]);
		// The page believes code help is on, as a page loaded before the switch
		// was turned off would; the API's own check is what answers.
		await page.route("**/me/settings", async (route) => {
			const response = await route.fetch();
			const body = (await response.json()) as Record<string, unknown>;
			await route.fulfill({
				response,
				json: { ...body, codeHelpLanguages: ["python", "typescript"] },
			});
		});
		const { wire, project } = await openPython(page, student);

		await expect
			.poll(() => wire.closes.filter((close) => close.code === 4416).length, {
				timeout: 30_000,
			})
			.toBeGreaterThan(0);
		expect(wire.closes[0]?.reason).toBe("code help is off");
		const status = codeHelpStatus(page, PATH);
		await expect(status).toHaveCount(0);
		await expect(button(page, "Restart code help")).toHaveCount(0);

		await typeAndSave(page, student, project.slug, "w");
		await windowFocus(page);
		await page.waitForTimeout(RETRY_WINDOW_MS + 1000);
		expect(wire.opened("python")).toBe(1);
		expect(wire.opened("ruff")).toBe(1);
		await expect(status).toHaveCount(0);
	});

	test("Python off and TypeScript on: a .py file is plain and a .ts file keeps code help", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		await setLanguages("{typescript}");
		const wire = await watchLanguageServers(page);
		await saveQuickly(student.userId);
		await openProjectFiles(page, student, "Mixed", {
			[PATH]: CONTENT,
			"app.ts": "export const answer: number = 42;\n",
		});
		await expect(editorLines(page, PATH)).toContainText("answer", { timeout: 60_000 });

		// The TypeScript file has code help, so its squiggle shows.
		await page.getByTestId("tab-file:app.ts").click();
		await expect(codeHelpStatus(page, "app.ts")).toHaveText("Code help ready", {
			timeout: 30_000,
		});
		await expect(
			page.getByTestId("editor-app.ts").locator(".squiggly-error").first(),
		).toBeVisible({ timeout: 30_000 });

		// The Python file, in the same page, is a plain editor with colours only.
		await page.getByTestId(`tab-file:${PATH}`).click();
		await expect(page.getByTestId(`editor-${PATH}`)).toBeVisible();
		await expect(page.getByTestId(`editor-code-help-${PATH}`)).toHaveCount(0);
		await expect(
			page.getByTestId(`editor-${PATH}`).locator(".squiggly-warning"),
		).toHaveCount(0);
		await expect
			.poll(async () =>
				editorLines(page, PATH)
					.locator("span[class^='mtk']")
					.evaluateAll((spans) => new Set(spans.map((span) => span.className)).size),
			)
			.toBeGreaterThan(1);
		expect(wire.opened("python")).toBe(0);
		expect(wire.opened("ruff")).toBe(0);
		expect(wire.opened("typescript")).toBe(1);

		// Problems lists the TypeScript file alone, and the tab is there.
		await page.getByTestId("right-pane-tab-problems").click();
		await expect(page.getByTestId("right-pane-count-problems")).toHaveText("1");
		await expect(page.getByTestId("problem-app.ts:1")).toBeVisible();
		await expect(page.getByTestId(`problem-${PATH}:1`)).toHaveCount(0);
	});

	test("the editor follows the set of languages when the window comes back", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const { wire } = await openPython(page, student);
		await ready(page);
		const problemsTab = page.getByTestId("right-pane-tab-problems");
		await expect(problemsTab).toBeVisible();

		// The settings count as old after five seconds, so ask until it is read again.
		const followed = (count: number) => async () => {
			await windowVisible(page);
			return codeHelpStatus(page, PATH)
				.count()
				.then((now) => now === count);
		};

		// Python off, TypeScript on: the file turns plain, and Problems stays.
		await setLanguages("{typescript}");
		await expect.poll(followed(0), { timeout: 30_000 }).toBe(true);
		await expect(problemsTab).toBeVisible();

		// Both off: the Problems tab goes too.
		await setLanguages("{}");
		await expect
			.poll(
				async () => {
					await windowVisible(page);
					return problemsTab.count();
				},
				{ timeout: 30_000 },
			)
			.toBe(0);
		expect(wire.opened("python")).toBe(1);

		// Python on again: the open file gets code help without a reload.
		await setLanguages("{python}");
		await expect.poll(followed(1), { timeout: 30_000 }).toBe(true);
		await ready(page);
		expect(wire.opened("python")).toBe(2);
		await expect(problemsTab).toBeVisible();
	});

	test("a refusal for Python leaves TypeScript code help running", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		await setLanguages("{typescript}");
		// The page believes both languages are on, as one loaded before the change would.
		await page.route("**/me/settings", async (route) => {
			const response = await route.fetch();
			const body = (await response.json()) as Record<string, unknown>;
			await route.fulfill({
				response,
				json: { ...body, codeHelpLanguages: ["python", "typescript"] },
			});
		});
		const wire = await watchLanguageServers(page);
		await saveQuickly(student.userId);
		await openProjectFiles(page, student, "Refused", {
			[PATH]: CONTENT,
			"app.ts": "export const answer: number = 42;\n",
		});

		await expect
			.poll(() => wire.closes.filter((close) => close.code === 4416).length, {
				timeout: 30_000,
			})
			.toBeGreaterThan(0);
		await page.getByTestId("tab-file:app.ts").click();
		await expect(codeHelpStatus(page, "app.ts")).toHaveText("Code help ready", {
			timeout: 30_000,
		});
		await expect(
			page.getByTestId("editor-app.ts").locator(".squiggly-error").first(),
		).toBeVisible({ timeout: 30_000 });
		expect(wire.closes.every((close) => close.server !== "typescript")).toBe(true);
		await expect(codeHelpStatus(page, PATH)).toHaveCount(0);

		// The refused language is not tried again.
		await windowFocus(page);
		await page.waitForTimeout(RETRY_WINDOW_MS);
		expect(wire.opened("python")).toBe(1);
		expect(wire.opened("ruff")).toBe(1);
		expect(wire.opened("typescript")).toBe(1);
	});

	test("the agent's own close codes reach the page with fixed reasons", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const { wire } = await openPython(page, student);
		await ready(page);

		const closeFromAgent = async (code: number) => {
			const response = await fetch(`${FAKE_AGENT_URL}/__test/language-servers/close`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ code }),
			});
			expect(response.ok).toBe(true);
		};
		const status = codeHelpStatus(page, PATH);
		const lastClose = () => wire.closes.at(-1);

		await closeFromAgent(4412);
		await expect(status).toHaveText("Code help is on in another window");
		expect(lastClose()).toMatchObject({
			code: 4412,
			reason: "replaced by another window",
		});
		await button(page, "Use here").click();
		await ready(page);

		await closeFromAgent(4414);
		await expect(status).toHaveText("Code help stopped");
		expect(lastClose()).toMatchObject({ code: 4414, reason: "crashed" });
		await button(page, "Restart code help").click();
		await ready(page);

		await closeFromAgent(4415);
		await expect(status).toHaveText("Code help unavailable");
		expect(lastClose()).toMatchObject({ code: 4415, reason: "unavailable" });
		await button(page, "Restart code help").click();
		await ready(page);

		await closeFromAgent(4413);
		await expect(status).toHaveText("");
		expect(lastClose()).toMatchObject({ code: 4413, reason: "idle" });
	});
});
