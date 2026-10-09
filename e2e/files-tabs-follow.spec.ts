/**
 * An open tab follows its file when the files pane renames or moves it, and
 * keeps unsaved edits with auto-save on or off (SPEC.md §11.2, §13.5).
 * Several selected rows download as one zip (SPEC.md §11.2).
 */
import { expect, type Page, test } from "@playwright/test";
import {
	createProject,
	createStudent,
	expectNoViolations,
	openFileTab,
	query,
	readSeededFile,
	seedFile,
	toast,
	workspacePath,
} from "./helpers";
import { WEB_ORIGIN } from "./ports";

function row(page: Page, path: string) {
	return page.getByTestId(`file-row-${path}`);
}

function lines(page: Page, path: string) {
	return page.getByTestId(`editor-${path}`).locator(".view-lines");
}

/** Type at the end of the file's first line. */
async function typeAtEnd(page: Page, path: string, text: string) {
	await lines(page, path).click();
	await page.keyboard.press("Control+Home");
	await page.keyboard.press("End");
	await page.keyboard.type(text);
}

async function setAutoSave(page: Page, on: boolean) {
	const res = await page.request.put("/me/settings", {
		data: { autoSave: on },
		headers: { origin: WEB_ORIGIN },
	});
	expect(res.status()).toBe(200);
}

/** Rename one row from its menu. */
async function rename(page: Page, path: string, name: string) {
	await page.getByTestId(`file-menu-${path}`).click();
	await page.getByTestId("row-rename").click();
	await page.getByTestId("field-file-name").fill(name);
	await page.getByTestId("dialog-confirm").click();
}

test.describe("tabs follow moved files", () => {
	// Monaco is a large chunk the dev server transforms on first use.
	test.describe.configure({ timeout: 90_000 });

	test("a renamed file keeps its tab and its unsaved edits with auto-save off", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		await setAutoSave(page, false);
		const project = await openFileTab(
			page,
			student,
			"Rename off",
			"notes.txt",
			"first line\n",
		);
		await expect(lines(page, "notes.txt")).toContainText("first line", {
			timeout: 60_000,
		});
		await typeAtEnd(page, "notes.txt", " edited");
		await expect(page.getByTestId("file-status-notes.txt")).toHaveText("Unsaved");

		await rename(page, "notes.txt", "renamed.txt");

		await expect(page.getByTestId("tab-file:renamed.txt")).toBeVisible();
		await expect(page.getByTestId("tab-file:notes.txt")).toHaveCount(0);
		await expect(lines(page, "renamed.txt")).toContainText("first line edited", {
			timeout: 15_000,
		});
		await expect(page.getByTestId("file-status-renamed.txt")).toHaveText("Unsaved");
		await expect(page.getByTestId("tab-file:renamed.txt-dirty")).toBeVisible();
		// Nothing was written for the student: the file moved, unchanged.
		expect(await readSeededFile(student.workspaceId, project.slug, "renamed.txt")).toBe(
			"first line\n",
		);

		// Saving writes the new path.
		await lines(page, "renamed.txt").click();
		await page.keyboard.press("Control+s");
		await expect
			.poll(() => readSeededFile(student.workspaceId, project.slug, "renamed.txt"), {
				timeout: 15_000,
			})
			.toBe("first line edited\n");
		await page.screenshot({ path: "screenshots/tabs-follow-rename.png" });
	});

	test("a file moved into a folder keeps its tab and saves its edits there with auto-save on", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const opened = await createProject(student.workspaceId, { name: "Move on" });
		await seedFile(student.workspaceId, opened.slug, "lib/keep.txt", "keep\n");
		await seedFile(student.workspaceId, opened.slug, "app.js", "let a;\n");
		await query("update projects set layout = $2 where id = $1", [
			opened.id,
			JSON.stringify({
				tabs: [{ id: "file:app.js", root: { type: "file", path: "app.js" } }],
			}),
		]);
		await page.goto(workspacePath(student.workspaceId, opened.id));
		await expect(lines(page, "app.js")).toContainText("let a;", { timeout: 60_000 });
		await expect(row(page, "lib")).toBeVisible({ timeout: 15_000 });

		// Move before the five-second auto-save runs out.
		await typeAtEnd(page, "app.js", " // moved");
		await page.getByTestId("file-menu-app.js").click();
		await page.getByTestId("row-move").click();
		const dialog = page.getByTestId("dialog-move-file");
		await dialog.getByTestId("move-folder-lib").click();
		await dialog.getByTestId("dialog-confirm").click();

		await expect(page.getByTestId("tab-file:lib/app.js")).toBeVisible();
		await expect(lines(page, "lib/app.js")).toContainText("let a; // moved", {
			timeout: 15_000,
		});
		await expect
			.poll(() => readSeededFile(student.workspaceId, opened.slug, "lib/app.js"), {
				timeout: 20_000,
			})
			.toBe("let a; // moved\n");
		await expect(page.getByTestId("file-status-lib/app.js")).toHaveText("Saved");
	});

	test("a renamed folder takes the open file inside it along", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const project = await openFileTab(
			page,
			student,
			"Folder rename",
			"src/main.py",
			"print(1)\n",
		);
		await expect(lines(page, "src/main.py")).toContainText("print(1)", {
			timeout: 60_000,
		});
		await expect(row(page, "src")).toBeVisible({ timeout: 15_000 });
		await rename(page, "src", "app");

		await expect(page.getByTestId("tab-file:app/main.py")).toBeVisible();
		await expect(page.getByTestId("tab-file:app/main.py")).toHaveAttribute(
			"aria-selected",
			"true",
		);
		await expect(lines(page, "app/main.py")).toContainText("print(1)");
		await expect(page.getByTestId("file-banner")).toHaveCount(0);
		expect(await readSeededFile(student.workspaceId, project.slug, "app/main.py")).toBe(
			"print(1)\n",
		);
	});

	for (const scheme of ["light", "dark"] as const) {
		test(`a renamed file's tab has no axe violations (${scheme})`, async ({
			page,
			context,
		}) => {
			await page.emulateMedia({ colorScheme: scheme });
			const student = await createStudent(context);
			await openFileTab(page, student, `Axe rename ${scheme}`, "a.txt", "a\n");
			await expect(lines(page, "a.txt")).toContainText("a", { timeout: 60_000 });
			await rename(page, "a.txt", "b.txt");
			await expect(lines(page, "b.txt")).toContainText("a", { timeout: 15_000 });
			await expectNoViolations(page);
		});
	}
});

test.describe("download selection", () => {
	test("several selected rows download as one zip", async ({ page, context }) => {
		const student = await createStudent(context);
		const project = await createProject(student.workspaceId, { name: "Selection" });
		await seedFile(student.workspaceId, project.slug, "a.txt", "a\n");
		await seedFile(student.workspaceId, project.slug, "b.txt", "b\n");
		await page.goto(workspacePath(student.workspaceId, project.id));
		await expect(row(page, "b.txt")).toBeVisible({ timeout: 15_000 });

		await row(page, "a.txt").click();
		await row(page, "b.txt").click({ modifiers: ["Shift"] });
		await page.getByTestId("file-menu-b.txt").click();
		const downloadPromise = page.waitForEvent("download");
		await page.getByRole("menuitem", { name: "Download 2 items as zip" }).click();
		const download = await downloadPromise;

		expect(download.suggestedFilename()).toBe(`${project.slug}.zip`);
		const url = new URL(download.url());
		expect(url.pathname).toMatch(/\/download$/);
		expect(url.searchParams.getAll("path")).toEqual(["a.txt", "b.txt"]);
	});

	test("a selection of more than 100 rows is pointed at its folder instead", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const project = await createProject(student.workspaceId, { name: "Too many" });
		const names = Array.from(
			{ length: 101 },
			(_, index) => `f${String(index).padStart(3, "0")}.txt`,
		);
		await Promise.all(
			names.map((name) =>
				seedFile(student.workspaceId, project.slug, `many/${name}`, "x\n"),
			),
		);
		await page.goto(workspacePath(student.workspaceId, project.id));
		await row(page, "many").click({ timeout: 15_000 });
		const first = `many/${names[0]}`;
		const last = `many/${names[100]}`;
		await row(page, first).click();
		await row(page, last).click({ modifiers: ["Shift"] });
		await expect(row(page, last)).toHaveAttribute("data-selected", "true");

		let downloads = 0;
		page.on("download", () => {
			downloads += 1;
		});
		await page.getByTestId(`file-menu-${last}`).click();
		await page.getByRole("menuitem", { name: "Download 101 items as zip" }).click();
		const refused = toast(page, "One download can hold at most 100 selected items");
		await expect(refused).toBeVisible();
		await expect(refused).toContainText("Download the folder that holds them instead");
		expect(downloads).toBe(0);
	});
});
