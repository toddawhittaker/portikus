import { expect, type Page, test } from "@playwright/test";
import {
	createStudent,
	openFileTab,
	readSeededFile,
	seedGit,
	type TestProject,
	type TestStudent,
} from "./helpers";

/**
 * Markdown tabs: the raw text and the rendered preview side by side, the one
 * Diff button, and the two sides scrolling together (SPEC.md §13.2, §13.4,
 * issue #218).
 */
test.describe("markdown tab", () => {
	// Monaco is a large chunk the dev server transforms on first use.
	test.describe.configure({ timeout: 90_000 });

	const PATH = "README.md";
	const CONTENT = [
		"---",
		"title: Project notes",
		"draft: true",
		"---",
		"",
		"## Ports",
		"",
		"| Port | Use |",
		"| --- | --- |",
		"| 3000 | web |",
		"",
		"<script>alert(1)</script>",
		"",
	].join("\n");

	function openMarkdownTab(page: Page, student: TestStudent): Promise<TestProject> {
		return openFileTab(page, student, "Markdown", PATH, CONTENT);
	}

	test("a Markdown file opens as raw text beside a read-only preview", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		await openMarkdownTab(page, student);

		const preview = page.getByTestId("markdown-preview");
		await expect(preview).toBeVisible({ timeout: 30_000 });
		await expect(page.getByTestId("markdown-split")).toBeVisible();
		// The raw Markdown is on the left, in Monaco.
		const lines = page.getByTestId(`editor-${PATH}`).locator(".view-lines");
		await expect(lines).toContainText("title: Project notes", { timeout: 60_000 });
		await expect(lines).toContainText("## Ports");

		await expect(preview.getByRole("heading", { name: "Ports" })).toBeVisible();
		await expect(preview.locator("table")).toBeVisible();
		await expect(preview.getByRole("cell", { name: "3000" })).toBeVisible();

		// The script tag is text, not an element the browser ran.
		await expect(preview).toContainText("<script>alert(1)</script>");
		await expect(preview.locator("script")).toHaveCount(0);

		// Nothing in the preview can be typed into, and the view buttons are
		// gone: the split is the only layout (issue #218).
		await expect(preview.locator("[contenteditable]")).toHaveCount(0);
		await expect(page.getByTestId("markdown-mode-code")).toHaveCount(0);
		await expect(page.getByTestId("markdown-mode-rich")).toHaveCount(0);
		await expect(page.getByTestId("markdown-mode-split")).toHaveCount(0);
		await expect(page.getByTestId(`file-view-edit-${PATH}`)).toHaveCount(0);

		// Frontmatter is collapsed and never becomes a heading.
		const block = page.getByTestId("markdown-frontmatter");
		await expect(block.locator("summary")).toHaveText("Front matter");
		await expect(
			preview.getByRole("heading", { name: /title: Project notes/ }),
		).toHaveCount(0);
		await block.locator("summary").click();
		await expect(block).toContainText("title: Project notes");
	});

	test("lists render with their markers (issue #154)", async ({ page, context }) => {
		const student = await createStudent(context);
		await openFileTab(
			page,
			student,
			"Lists",
			"LIST.md",
			"- one\n- two\n  - nested\n\n5. five\n6. six\n",
		);

		const preview = page.getByTestId("markdown-preview");
		await expect(preview).toBeVisible({ timeout: 30_000 });
		await expect(preview.locator("ul > li").first()).toHaveCSS(
			"list-style-type",
			"disc",
		);
		await expect(preview.locator("ul ul > li").first()).toHaveCSS(
			"list-style-type",
			"circle",
		);
		await expect(preview.locator("ol > li").first()).toHaveCSS(
			"list-style-type",
			"decimal",
		);
		// An ordered list that starts at 5 is numbered from 5.
		await expect(preview.locator("ol")).toHaveAttribute("start", "5");
		// The markers sit in a real indent, not flush against the text.
		const padding = await preview
			.locator("ul")
			.first()
			.evaluate((node) => Number.parseFloat(getComputedStyle(node).paddingLeft));
		expect(padding).toBeGreaterThan(10);
	});

	test("the two sides scroll together, by wheel and by keyboard (issue #218)", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const long = Array.from(
			{ length: 200 },
			(_, index) => `## Heading ${index + 1}\n\nParagraph ${index + 1}.\n`,
		).join("\n");
		await openFileTab(page, student, "Long", "LONG.md", long);
		const preview = page.getByTestId("markdown-preview");
		await expect(preview).toBeVisible({ timeout: 30_000 });

		const editor = page.getByTestId("editor-LONG.md");
		await expect(editor.locator(".view-lines")).toContainText("Heading 1", {
			timeout: 60_000,
		});

		// The code side has a scrollbar slider with real height, inside its
		// own panel rather than past its right edge (issue #154).
		const slider = editor.locator(".scrollbar.vertical .slider").first();
		await expect(slider).toBeVisible();
		const sliderBox = await slider.boundingBox();
		expect(sliderBox?.height ?? 0).toBeGreaterThan(0);
		expect(sliderBox?.width ?? 0).toBeGreaterThan(0);
		const panel = await page.getByTestId("md-code-pane").boundingBox();
		expect(sliderBox?.x ?? 0).toBeLessThan((panel?.x ?? 0) + (panel?.width ?? 0));
		await expect(slider).toHaveCSS("opacity", "1");

		expect(await previewScrollTop(page)).toBe(0);

		// The keyboard test below needs the editor focused, and after the
		// wheel the first line is behind the tab header, so click it now.
		await editor.locator(".view-line").first().click();

		// A student scrolls with the wheel, so that is what is tested first:
		// the preview must follow, and keep following, not stop after a step.
		const box = await editor.boundingBox();
		await page.mouse.move(
			(box?.x ?? 0) + (box?.width ?? 0) / 2,
			(box?.y ?? 0) + (box?.height ?? 0) / 2,
		);
		for (let step = 0; step < 10; step += 1) {
			await page.mouse.wheel(0, 400);
		}
		await expect
			.poll(() => previewScrollTop(page), { timeout: 10_000 })
			.toBeGreaterThan(0);

		// Keyboard scrolling to the end takes the preview to the end too.
		await page.keyboard.press("Control+End");
		await expect
			.poll(() => firstVisibleLine(page), { timeout: 10_000 })
			.toBeGreaterThan(100);
		await expect
			.poll(() => previewRatio(page), { timeout: 10_000 })
			.toBeGreaterThan(0.8);

		// And scrolling the preview back to the top brings the editor with it.
		await preview.evaluate((node) => {
			node.scrollTop = 0;
		});
		await expect
			.poll(() => firstVisibleLine(page), { timeout: 10_000 })
			.toBeLessThan(5);

		// Scrolling the preview down again moves the editor down again, so
		// following works repeatedly, in both directions.
		await preview.evaluate((node) => {
			node.scrollTop = (node.scrollHeight - node.clientHeight) / 2;
		});
		await expect
			.poll(() => firstVisibleLine(page), { timeout: 10_000 })
			.toBeGreaterThan(50);
	});

	test("typing in the raw side updates the preview and saves", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const project = await openMarkdownTab(page, student);
		const lines = page.getByTestId(`editor-${PATH}`).locator(".view-lines");
		await expect(lines).toContainText("## Ports", { timeout: 60_000 });

		await lines.getByText("## Ports").click();
		await page.keyboard.press("End");
		await page.keyboard.type(" and hosts");
		await expect(
			page.getByTestId("markdown-preview").getByRole("heading", {
				name: "Ports and hosts",
			}),
		).toBeVisible({ timeout: 10_000 });

		await expect(page.getByTestId(`file-status-${PATH}`)).toHaveText("Saved", {
			timeout: 15_000,
		});
		await expect
			.poll(async () => readSeededFile(student.workspaceId, project.slug, PATH), {
				timeout: 15_000,
			})
			.toContain("## Ports and hosts");
	});

	test("Diff swaps the preview for this file's diff, and back (issue #218)", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const project = await openFileTab(
			page,
			student,
			"Diffable",
			PATH,
			"# Notes\n\nSecond line.\n",
		);
		await seedGit(student.workspaceId, project.slug, {
			diffs: {
				[PATH]: {
					status: "M",
					before: "# Notes\n",
					after: "# Notes\n\nSecond line.\n",
					binary: false,
					tooLarge: false,
				},
			},
		});
		await expect(page.getByTestId("markdown-preview")).toBeVisible({
			timeout: 30_000,
		});

		await page.getByTestId(`file-view-diff-${PATH}`).click();
		const diff = page.getByTestId(`diff-editor-${PATH}`);
		await expect(diff.locator(".monaco-diff-editor")).toBeVisible({ timeout: 60_000 });
		await expect(diff).toContainText("Second line.");
		// The preview is gone; the editable raw text is still there.
		await expect(page.getByTestId("markdown-preview")).toHaveCount(0);
		await expect(page.getByTestId(`editor-${PATH}`)).toBeVisible();

		// The raw side still edits the file while the diff is up.
		const lines = page.getByTestId(`editor-${PATH}`).locator(".view-lines");
		await lines.getByText("Second line.").click();
		await page.keyboard.press("End");
		await page.keyboard.type(" Third.");
		await expect(page.getByTestId(`file-status-${PATH}`)).toHaveText("Saved", {
			timeout: 15_000,
		});

		await page.getByTestId(`file-view-diff-${PATH}`).click();
		await expect(page.getByTestId(`diff-pane-${PATH}`)).toHaveCount(0);
		await expect(page.getByTestId("markdown-preview")).toBeVisible();
	});
});

/** Where the preview is scrolled to, in pixels. */
function previewScrollTop(page: Page): Promise<number> {
	return page.getByTestId("markdown-preview").evaluate((node) => node.scrollTop);
}

/** How far down its own scrollable range the preview sits, from 0 to 1. */
function previewRatio(page: Page): Promise<number> {
	return page
		.getByTestId("markdown-preview")
		.evaluate((node) => node.scrollTop / (node.scrollHeight - node.clientHeight));
}

/** The topmost line number Monaco is showing, which says where it scrolled. */
function firstVisibleLine(page: Page): Promise<number> {
	return page
		.locator(".margin-view-overlays")
		.first()
		.evaluate((node) => {
			const numbers = [...node.querySelectorAll(".line-numbers")]
				.map((line) => Number.parseInt(line.textContent ?? "", 10))
				.filter((value) => Number.isFinite(value));
			return numbers.length > 0 ? Math.min(...numbers) : 0;
		});
}
