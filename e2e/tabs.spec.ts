import { expect, type Locator, type Page, test } from "@playwright/test";
import {
	createProject,
	createStudent,
	query,
	seedFile,
	workspacePath,
} from "./helpers";

/**
 * The centre-pane tab strip (SPEC.md §8.3, issue #240): every tab is the same
 * width, they shrink together, and past the floor width the strip scrolls.
 */
test.describe("tab strip", () => {
	/** Seed `count` file tabs into a project's saved layout and open it. */
	async function openWithTabs(
		page: Page,
		workspaceId: string,
		name: string,
		count: number,
	): Promise<string> {
		const project = await createProject(workspaceId, { name });
		const paths = Array.from({ length: count }, (_item, index) => `file-${index}.txt`);
		for (const path of paths) {
			await seedFile(workspaceId, project.slug, path, `contents of ${path}\n`);
		}
		await query("update projects set layout = $2 where id = $1", [
			project.id,
			JSON.stringify({
				tabs: paths.map((path) => ({
					id: `file:${path}`,
					root: { type: "file", path },
				})),
			}),
		]);
		await page.goto(workspacePath(workspaceId, project.id));
		await expect(page.getByTestId("work-tabs")).toBeVisible({ timeout: 15_000 });
		await expect(page.getByTestId(`tab-file:${paths[0]}`)).toBeAttached();
		return project.id;
	}

	function tab(page: Page, path: string): Locator {
		return page.getByTestId(`tab-file:${path}`);
	}

	async function widthOf(locator: Locator): Promise<number> {
		const box = await locator.boundingBox();
		if (!box) throw new Error("the tab has no box");
		return box.width;
	}

	test("tabs are equal width whatever their labels say", async ({ page, context }) => {
		const student = await createStudent(context);
		const project = await createProject(student.workspaceId, { name: "Even" });
		const paths = ["a.txt", "a-rather-long-file-name-indeed.txt", "b.txt"];
		for (const path of paths) {
			await seedFile(student.workspaceId, project.slug, path, "x\n");
		}
		await query("update projects set layout = $2 where id = $1", [
			project.id,
			JSON.stringify({
				tabs: paths.map((path) => ({
					id: `file:${path}`,
					root: { type: "file", path },
				})),
			}),
		]);
		await page.goto(workspacePath(student.workspaceId, project.id));
		await expect(tab(page, "a.txt")).toBeVisible({ timeout: 15_000 });

		const widths = await Promise.all(paths.map((path) => widthOf(tab(page, path))));
		const first = widths[0] as number;
		for (const width of widths) expect(Math.abs(width - first)).toBeLessThan(2);
	});

	test("many tabs shrink to icon and close, then the strip scrolls", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		await openWithTabs(page, student.workspaceId, "Crowded", 40);

		// At the floor width the label has no room left, but the kind icon and
		// the close control are still there on every tab.
		const first = tab(page, "file-0.txt");
		expect(await widthOf(first)).toBeLessThan(70);
		const label = first.locator(".pk-tab-label");
		expect(await widthOf(label)).toBeLessThan(2);
		await expect(page.getByTestId("tab-file:file-0.txt-close")).toBeAttached();
		await expect(first.locator("svg").first()).toBeAttached();

		// Past the floor the strip is a scroller.
		const list = page.getByRole("tablist");
		const overflow = await list.evaluate(
			(element) => element.scrollWidth - element.clientWidth,
		);
		expect(overflow).toBeGreaterThan(0);
	});

	test("selecting a tab scrolls it into view", async ({ page, context }) => {
		const student = await createStudent(context);
		await openWithTabs(page, student.workspaceId, "Scrolling", 40);
		const list = page.getByRole("tablist");
		expect(await list.evaluate((element) => element.scrollLeft)).toBe(0);

		// Opening the last file from the tree selects its tab, far off screen.
		await page.getByTestId("file-row-file-39.txt").click();

		await expect
			.poll(async () => list.evaluate((element) => element.scrollLeft))
			.toBeGreaterThan(0);
	});

	test("a tab with unsaved edits shows a dot and reveals close on hover", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const project = await createProject(student.workspaceId, { name: "Dirty" });
		await seedFile(student.workspaceId, project.slug, "notes.txt", "one\n");
		await query("update projects set layout = $2 where id = $1", [
			project.id,
			JSON.stringify({
				tabs: [{ id: "file:notes.txt", root: { type: "file", path: "notes.txt" } }],
			}),
		]);
		await page.goto(workspacePath(student.workspaceId, project.id));
		await expect(page.getByTestId("file-pane-notes.txt")).toBeVisible({
			timeout: 15_000,
		});

		const editor = page.getByTestId("editor-notes.txt").locator(".view-lines");
		await expect(editor).toContainText("one", { timeout: 60_000 });
		await editor.click();
		await page.keyboard.type("two");

		const dot = page.getByTestId("tab-file:notes.txt-dirty");
		await expect(dot).toBeVisible();
		const close = page.getByTestId("tab-file:notes.txt-close");
		await expect(close).toBeHidden();

		await tab(page, "notes.txt").hover();
		await expect(close).toBeVisible();
		await expect(dot).toBeHidden();
	});

	test("closing works in a scrolled strip", async ({ page, context }) => {
		const student = await createStudent(context);
		const projectId = await openWithTabs(page, student.workspaceId, "Closing", 40);
		const list = page.getByRole("tablist");
		await list.evaluate((element) => {
			element.scrollLeft = element.scrollWidth;
		});

		const last = tab(page, "file-39.txt");
		await last.scrollIntoViewIfNeeded();
		await page.getByTestId("tab-file:file-39.txt-close").click();

		await expect(last).toHaveCount(0);
		await expect
			.poll(async () => {
				const [row] = await query<{ layout: { tabs: unknown[] } }>(
					"select layout from projects where id = $1",
					[projectId],
				);
				return row?.layout.tabs.length ?? 0;
			})
			.toBe(39);
	});
});
