import { expect, type Page, test } from "@playwright/test";
import { holdCodeHelpSwitch } from "./code-help-helpers";
import {
	createProject,
	createStudent,
	expectNoViolations,
	query,
	routeApi,
	seedFile,
	type TestStudent,
	workspacePath,
} from "./helpers";

/**
 * The Problems tab (SPEC.md §13.6, §25.8). The fake agent's scripted language
 * servers answer every Python file with one warning and every TypeScript file
 * with one error, both on line 1, so what these tests pin is where the list
 * gets its rows, what a row does, and who can reach it.
 */

const PYTHON = "def main():\n    one = 1\n    two = 2\n    three = 3\n    return one\n";
const TYPESCRIPT = "export const answer: number = 42;\n";

/** A project whose saved layout opens these files as tabs, the first one active. */
async function openProject(
	page: Page,
	student: TestStudent,
	name: string,
	files: Record<string, string>,
) {
	const project = await createProject(student.workspaceId, { name });
	for (const [path, content] of Object.entries(files)) {
		await seedFile(student.workspaceId, project.slug, path, content);
	}
	await query("update projects set layout = $2 where id = $1", [
		project.id,
		JSON.stringify({
			tabs: Object.keys(files).map((path) => ({
				id: `file:${path}`,
				root: { type: "file", path },
			})),
		}),
	]);
	await page.goto(workspacePath(student.workspaceId, project.id));
	await expect(page.getByTestId(`file-pane-${Object.keys(files)[0]}`)).toBeVisible({
		timeout: 15_000,
	});
	return project;
}

async function setAppearance(student: TestStudent, appearance: "light" | "dark") {
	await query(
		"update users set editor_settings = editor_settings || $1::jsonb where id = $2",
		[JSON.stringify({ appearance }), student.userId],
	);
}

function problemsTab(page: Page) {
	return page.getByTestId("right-pane-tab-problems");
}

test.describe("Problems tab", () => {
	holdCodeHelpSwitch(test);

	test("lists the open files' errors and warnings by file, with a count on the tab", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		await openProject(page, student, "Problems list", {
			"main.py": PYTHON,
			"app.ts": TYPESCRIPT,
		});

		await expect(problemsTab(page)).toBeVisible();
		await expect(page.getByTestId("right-pane-count-problems")).toHaveText("2", {
			timeout: 20_000,
		});
		await problemsTab(page).click();

		const panel = page.getByRole("tabpanel", { name: /^Problems/ });
		await expect(
			panel.getByRole("heading", { level: 2, name: "Problems" }),
		).toHaveCount(1);
		const files = panel.getByRole("heading", { level: 3 });
		await expect(files).toHaveText(["app.ts", "main.py"]);
		await expect(panel.getByTestId("problem-main.py:1")).toHaveText(
			"Warning Line 1 scripted warning",
		);
		await expect(panel.getByTestId("problem-app.ts:1")).toHaveText(
			"Error Line 1 scripted error",
		);
		await expect(panel.getByTestId("problems-summary")).toHaveText(
			"1 error, 1 warning in 2 open files",
		);
	});

	test("a row opens its file at its line", async ({ page, context }) => {
		const student = await createStudent(context);
		await openProject(page, student, "Problems row", {
			"main.py": PYTHON,
			"app.ts": TYPESCRIPT,
		});
		await expect(page.getByTestId("right-pane-count-problems")).toHaveText("2", {
			timeout: 20_000,
		});

		// Put the cursor on the last line, then leave for the other file's tab.
		const editor = page.getByTestId("editor-main.py");
		await editor.locator(".view-lines").click();
		await page.keyboard.press("Control+End");
		const activeLine = editor.locator(".active-line-number");
		await expect(activeLine).toHaveText("6");
		await page.getByTestId("tab-file:app.ts").click();
		await expect(page.getByTestId("file-pane-app.ts")).toBeVisible();

		await problemsTab(page).click();
		await page.getByTestId("problem-main.py:1").click();

		await expect(page.getByTestId("file-pane-main.py")).toBeVisible();
		await expect(activeLine).toHaveText("1");
	});

	test("closing a file removes its problems", async ({ page, context }) => {
		const student = await createStudent(context);
		await openProject(page, student, "Problems close", {
			"main.py": PYTHON,
			"app.ts": TYPESCRIPT,
		});
		await expect(page.getByTestId("right-pane-count-problems")).toHaveText("2", {
			timeout: 20_000,
		});
		await problemsTab(page).click();
		await expect(page.getByTestId("problem-app.ts:1")).toBeVisible();

		await page.getByTestId("tab-file:app.ts").click({ button: "right" });
		await page
			.getByRole("menu", { name: "Actions for app.ts" })
			.getByRole("menuitem", { name: "Close tab" })
			.click();

		await expect(page.getByTestId("problem-app.ts:1")).toHaveCount(0);
		await expect(page.getByTestId("problem-main.py:1")).toBeVisible();
		await expect(page.getByTestId("right-pane-count-problems")).toHaveText("1");

		await page.getByTestId("tab-file:main.py").click({ button: "right" });
		await page
			.getByRole("menu", { name: "Actions for main.py" })
			.getByRole("menuitem", { name: "Close tab" })
			.click();

		const empty = page.getByTestId("problems-empty");
		await expect(empty).toBeVisible();
		await expect(empty).toContainText("No problems in open files");
		await expect(empty).toContainText("files you have open");
		await expect(empty).toContainText("Checks covers the whole project");
		await expect(page.getByTestId("right-pane-count-problems")).toHaveCount(0);
	});

	test("the empty state sends you to Checks", async ({ page, context }) => {
		const student = await createStudent(context);
		const project = await createProject(student.workspaceId, {
			name: "Problems empty",
		});
		await page.goto(workspacePath(student.workspaceId, project.id));
		await problemsTab(page).click();

		await expect(page.getByTestId("problems-empty")).toBeVisible();
		await page.getByRole("button", { name: "Open Checks" }).click();
		await expect(page.getByTestId("right-pane-tab-checks")).toHaveAttribute(
			"aria-selected",
			"true",
		);
	});

	test("a long unbroken message stays inside the narrowest pane", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		await page.setViewportSize({ width: 1024, height: 800 });
		const longName = `${"x".repeat(80)}.py`;
		await openProject(page, student, "Problems narrow", { [longName]: PYTHON });
		await problemsTab(page).click();
		const row = page.getByTestId(`problem-${longName}:1`);
		await expect(row).toBeVisible({ timeout: 20_000 });

		await page.screenshot({ path: "screenshots/problems-narrow-light.png" });
		const pane = await page.getByRole("tabpanel", { name: /^Problems/ }).boundingBox();
		const box = await row.boundingBox();
		expect(pane).not.toBeNull();
		expect(box).not.toBeNull();
		expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(
			(pane?.x ?? 0) + (pane?.width ?? 0) + 1,
		);
		const heading = await page.getByRole("heading", { level: 3 }).first().boundingBox();
		expect((heading?.x ?? 0) + (heading?.width ?? 0)).toBeLessThanOrEqual(
			(pane?.x ?? 0) + (pane?.width ?? 0) + 1,
		);
	});
});

test.describe("the five tabs at the default pane width", () => {
	holdCodeHelpSwitch(test);

	for (const appearance of ["light", "dark"] as const) {
		test(`all five tabs show whole, with no sideways scroll, at 1280 px (${appearance})`, async ({
			page,
			context,
		}) => {
			const student = await createStudent(context);
			await setAppearance(student, appearance);
			await page.setViewportSize({ width: 1280, height: 720 });
			await openProject(page, student, `Problems tabs ${appearance}`, {
				"main.py": PYTHON,
				"app.ts": TYPESCRIPT,
			});
			await expect(page.locator("html")).toHaveAttribute("data-theme", appearance, {
				timeout: 15_000,
			});
			await expect(page.getByTestId("right-pane-count-problems")).toHaveText("2", {
				timeout: 20_000,
			});

			const strip = page.locator(".pk-pane-tabs");
			const scroll = await strip.evaluate((element) => ({
				scrollWidth: element.scrollWidth,
				clientWidth: element.clientWidth,
			}));
			expect(scroll.scrollWidth).toBeLessThanOrEqual(scroll.clientWidth);

			const stripBox = await strip.boundingBox();
			const names = ["files", "checks", "running", "monitor", "problems"];
			for (const name of names) {
				const tab = page.getByTestId(`right-pane-tab-${name}`);
				await expect(tab).toBeVisible();
				const box = await tab.boundingBox();
				expect(box?.x ?? -1).toBeGreaterThanOrEqual(stripBox?.x ?? 0);
				expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(
					(stripBox?.x ?? 0) + (stripBox?.width ?? 0) + 0.5,
				);
				// SPEC.md §25.8: a target of at least 24 by 24 CSS pixels.
				expect(box?.width ?? 0).toBeGreaterThanOrEqual(24);
				expect(box?.height ?? 0).toBeGreaterThanOrEqual(24);
			}
			await page.getByTestId("right-pane-tab-problems").click();
			await page.screenshot({ path: `screenshots/problems-tabs-${appearance}.png` });
			await expectNoViolations(page, ".pk-pane-tabs");
		});
	}
});

test.describe("Problems tab with code help off", () => {
	test("the tab is not shown and no language-server socket opens", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const sockets: string[] = [];
		page.on("websocket", (socket) => {
			if (socket.url().includes("/language-servers/")) sockets.push(socket.url());
		});
		await routeApi(page, "**/me/settings", async (route) => {
			const response = await route.fetch();
			const settings = await response.json();
			await route.fulfill({
				response,
				json: { ...settings, codeHelpLanguages: [] },
			});
		});

		await openProject(page, student, "Problems off", { "main.py": PYTHON });

		await expect(page.getByRole("tab", { name: "Monitor" })).toBeVisible();
		await expect(problemsTab(page)).toHaveCount(0);
		await expect(page.getByRole("tab", { name: /Problems/ })).toHaveCount(0);
		await expect(page.getByTestId("editor-main.py")).toBeVisible();
		expect(sockets).toEqual([]);
	});
});

test.describe("Problems tab accessibility", () => {
	holdCodeHelpSwitch(test);

	test("keyboard: the tab strip reaches Problems and a row opens its file", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		await openProject(page, student, "Problems keys", {
			"main.py": PYTHON,
			"app.ts": TYPESCRIPT,
		});
		await expect(page.getByTestId("right-pane-count-problems")).toHaveText("2", {
			timeout: 20_000,
		});
		await page.getByTestId("tab-file:app.ts").click();

		// End on the strip lands on the last tab, which is Problems.
		await page.getByRole("tab", { name: "Files" }).focus();
		await page.keyboard.press("End");
		await expect(problemsTab(page)).toBeFocused();
		await expect(problemsTab(page)).toHaveAttribute("aria-selected", "true");

		// Tab leaves the strip, through the panel, to the first row.
		const panel = page.getByRole("tabpanel", { name: /^Problems/ });
		const row = panel.getByTestId("problem-app.ts:1");
		await expect(row).toBeVisible();
		for (let presses = 0; presses < 4; presses++) {
			if (await row.evaluate((element) => element === document.activeElement)) break;
			await page.keyboard.press("Tab");
		}
		await expect(row).toBeFocused();
		await expect(row).toHaveCSS("outline-style", "solid");

		await page.getByTestId("tab-file:main.py").click();
		await expect(page.getByTestId("file-pane-main.py")).toBeVisible();
		await row.focus();
		await page.keyboard.press("Enter");
		await expect(page.getByTestId("file-pane-app.ts")).toBeVisible();
	});

	for (const appearance of ["light", "dark"] as const) {
		test(`axe finds no violations in the Problems pane (${appearance})`, async ({
			page,
			context,
		}) => {
			const student = await createStudent(context);
			await setAppearance(student, appearance);
			await openProject(page, student, `Problems axe ${appearance}`, {
				"main.py": PYTHON,
				"app.ts": TYPESCRIPT,
			});
			await expect(page.locator("html")).toHaveAttribute("data-theme", appearance, {
				timeout: 15_000,
			});
			await expect(page.getByTestId("right-pane-count-problems")).toHaveText("2", {
				timeout: 20_000,
			});

			await problemsTab(page).click();
			await expect(page.getByTestId("problems-list")).toBeVisible();
			await page.screenshot({
				path: `screenshots/problems-list-${appearance}.png`,
			});
			await expectNoViolations(page, ".pk-right-pane");

			// The empty state, after both files close.
			for (const path of ["app.ts", "main.py"]) {
				await page.getByTestId(`tab-file:${path}`).click({ button: "right" });
				await page
					.getByRole("menu", { name: `Actions for ${path}` })
					.getByRole("menuitem", { name: "Close tab" })
					.click();
			}
			await expect(page.getByTestId("problems-empty")).toBeVisible();
			await page.screenshot({
				path: `screenshots/problems-empty-${appearance}.png`,
			});
			await expectNoViolations(page, ".pk-right-pane");
		});
	}
});
