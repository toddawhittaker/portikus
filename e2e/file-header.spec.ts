/**
 * A file pane has one header (SPEC.md §8.3, §25.8): the file's name at the
 * start, which is also the drag handle, the save state and the view buttons
 * between, and the actions menu at the end. The same holds alone in a tab
 * and in a split, for code, CSV, Markdown, an image and a diff. An image is
 * only looked at, so it has no view buttons. The diff's "Compare with" is a
 * small button in that header.
 */
import { expect, type Page, test } from "@playwright/test";
import {
	createProject,
	createStudent,
	expectNoViolations,
	query,
	seedFile,
	seedGit,
	type TestStudent,
	workspacePath,
	workTabs,
} from "./helpers";

const CODE = "src/app.ts";
const CSV = "data/marks.csv";
const MARKDOWN = "README.md";
const IMAGE = "assets/logo.png";
const ALL = [CODE, CSV, MARKDOWN, IMAGE];
/** A 1×1 PNG, enough for the browser to decode. */
const PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
	"base64",
);

function nameOf(path: string): string {
	return path.slice(path.lastIndexOf("/") + 1);
}

/** A project with the four files and a change to the code file, laid out as `tabs`. */
async function openProject(
	page: Page,
	student: TestStudent,
	name: string,
	tabs: unknown[],
): Promise<void> {
	const project = await createProject(student.workspaceId, { name });
	await seedFile(student.workspaceId, project.slug, CODE, "const answer = 42;\n");
	await seedFile(student.workspaceId, project.slug, CSV, "name,mark\nAda,90\nBo,72\n");
	await seedFile(
		student.workspaceId,
		project.slug,
		MARKDOWN,
		"# Notes\n\nSome text.\n",
	);
	await seedFile(student.workspaceId, project.slug, IMAGE, PNG);
	await seedGit(student.workspaceId, project.slug, {
		diffs: {
			[CODE]: {
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
		JSON.stringify({ tabs }),
	]);
	await page.goto(workspacePath(student.workspaceId, project.id));
}

/**
 * The pane shows one header holding the name, the menu, and view buttons or
 * none. A wide pane draws it as one line; a narrow one may put the controls
 * under the name, but never past the pane's edge.
 */
async function expectOneHeader(
	page: Page,
	path: string,
	{ toggles, wide }: { toggles: boolean; wide: boolean },
) {
	const frame = page.getByRole("region", { name: `File: ${path}` });
	await expect(frame).toBeVisible({ timeout: 30_000 });
	const header = frame.locator("header");
	await expect(header).toHaveCount(1);
	// The name is drawn once: no second bar repeats it.
	await expect(frame.getByText(nameOf(path), { exact: true })).toHaveCount(1);
	await expect(header.getByTestId(`file-frame-handle-${path}`)).toHaveText(
		nameOf(path),
	);
	// The folder follows the name, so two files of one name can be told apart.
	const folder = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : null;
	const dir = header.getByTestId(`file-header-dir-${path}`);
	if (folder) {
		await expect(dir).toHaveText(folder);
		const nameBox = await header.getByTestId(`file-frame-handle-${path}`).boundingBox();
		const dirBox = await dir.boundingBox();
		expect(nameBox?.x ?? 0).toBeLessThan(dirBox?.x ?? 0);
	} else {
		await expect(dir).toHaveCount(0);
	}
	const actions = header.getByRole("button", { name: `Actions for ${nameOf(path)}` });
	await expect(actions).toBeVisible();
	await expect(header.getByRole("group", { name: "File view" })).toHaveCount(
		toggles ? 1 : 0,
	);
	const box = await header.boundingBox();
	if (wide) expect(box?.height ?? 0).toBeLessThanOrEqual(40);
	const frameBox = await frame.boundingBox();
	const menuBox = await actions.boundingBox();
	expect((menuBox?.x ?? 0) + (menuBox?.width ?? 0)).toBeLessThanOrEqual(
		(frameBox?.x ?? 0) + (frameBox?.width ?? 0) + 1,
	);
	await expectNoViolations(page, `[data-testid="file-frame-${path}"] header`);
}

for (const colorScheme of ["light", "dark"] as const) {
	test.describe(`file pane header (${colorScheme})`, () => {
		// Monaco and the Markdown preview are large chunks the dev server
		// transforms on first use.
		test.describe.configure({ timeout: 120_000 });

		test.beforeEach(async ({ page }) => {
			await page.emulateMedia({ colorScheme });
		});

		test("each kind of file alone in its tab has one header", async ({
			page,
			context,
		}) => {
			const student = await createStudent(context);
			await openProject(
				page,
				student,
				"Lone header",
				ALL.map((path) => ({ id: `file:${path}`, root: { type: "file", path } })),
			);
			for (const path of ALL) {
				await workTabs(page)
					.getByRole("tab", { name: nameOf(path) })
					.click();
				await expectOneHeader(page, path, { toggles: path !== IMAGE, wide: true });
			}
			await page.screenshot({
				path: `screenshots/file-header-image-alone-${colorScheme}.png`,
			});

			// The code file's diff keeps the same one line, with Compare with in it.
			await workTabs(page)
				.getByRole("tab", { name: nameOf(CODE) })
				.click();
			await expect(page.getByTestId(`file-status-${CODE}`)).toHaveText("Saved", {
				timeout: 60_000,
			});
			await page.screenshot({
				path: `screenshots/file-header-code-alone-${colorScheme}.png`,
			});
			await page.getByTestId(`file-view-diff-${CODE}`).click();
			await expect(page.getByTestId(`diff-pane-${CODE}`)).toBeVisible();
			await expectOneHeader(page, CODE, { toggles: true, wide: true });
			const header = page.getByTestId(`diff-pane-${CODE}`).locator("header");
			const compare = header.getByRole("button", { name: "Compare with" });
			await expect(compare).toBeVisible();
			// WCAG 2.5.8: a target at least 24 pixels tall.
			expect((await compare.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(24);
			await expect(page.getByTestId(`diff-editor-${CODE}`)).toContainText(
				"const answer",
				{ timeout: 60_000 },
			);
			await page.screenshot({
				path: `screenshots/file-header-diff-alone-${colorScheme}.png`,
			});

			// The compact menu opens from the keyboard and adds no violation.
			await compare.focus();
			await page.keyboard.press("Enter");
			const menu = page.getByRole("menu", { name: "Compare with" });
			await expect(menu.getByRole("menuitem")).toHaveText([
				"Last commit",
				"A Git ref…",
				"A recovery point…",
			]);
			await page.screenshot({
				path: `screenshots/file-header-compare-menu-${colorScheme}.png`,
			});
			await expectNoViolations(page, '[role="menu"]');
			await page.keyboard.press("Escape");
			await expect(compare).toBeFocused();
		});

		test("each kind of file in a split has one header that is its drag handle", async ({
			page,
			context,
		}) => {
			const student = await createStudent(context);
			await openProject(page, student, "Split header", [
				{
					id: `file:${CODE}`,
					root: {
						type: "split",
						direction: "row",
						sizes: [25, 25, 25, 25],
						children: ALL.map((path) => ({ type: "file", path })),
					},
				},
			]);
			for (const path of ALL) {
				await expectOneHeader(page, path, { toggles: path !== IMAGE, wide: false });
			}
			await expect(page.getByTestId(`file-status-${CODE}`)).toHaveText("Saved", {
				timeout: 60_000,
			});
			await page.screenshot({
				path: `screenshots/file-header-split-${colorScheme}.png`,
			});

			// The menu is reachable by keyboard and offers the ways to move a pane.
			const actions = page.getByTestId(`file-frame-actions-${CSV}`);
			await actions.focus();
			await page.keyboard.press("Enter");
			await expect(
				page.getByRole("menuitem", { name: "Move to new tab" }),
			).toBeVisible();
			await page.keyboard.press("Escape");
			await expect(actions).toBeFocused();

			// A diff in a split keeps one header too.
			await page.getByTestId(`file-view-diff-${CODE}`).click();
			await expect(page.getByTestId(`diff-pane-${CODE}`)).toBeVisible();
			await expectOneHeader(page, CODE, { toggles: true, wide: false });
			await expect(page.getByTestId(`file-frame-handle-${CODE}`)).toHaveCount(1);
			await page.screenshot({
				path: `screenshots/file-header-split-diff-${colorScheme}.png`,
			});
		});
	});
}
