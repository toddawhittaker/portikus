import { expect, type Page, test } from "@playwright/test";
import {
	createStudent,
	openFileTab,
	readSeededFile,
	type TestProject,
	type TestStudent,
} from "./helpers";

/**
 * Markdown tabs: the Edit, Preview and Split views, and the frontmatter block
 * (SPEC.md §13.2, §13.4).
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

	test("a Markdown file opens rendered, with frontmatter kept out of the body", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		await openMarkdownTab(page, student);

		const preview = page.getByTestId("markdown-preview");
		await expect(preview).toBeVisible({ timeout: 30_000 });
		await expect(page.getByTestId("markdown-mode-preview")).toHaveAttribute(
			"aria-pressed",
			"true",
		);

		await expect(preview.getByRole("heading", { name: "Ports" })).toBeVisible();
		await expect(preview.locator("table")).toBeVisible();
		await expect(preview.getByRole("cell", { name: "3000" })).toBeVisible();

		// The script tag is text, not an element the browser ran.
		await expect(preview).toContainText("<script>alert(1)</script>");
		await expect(preview.locator("script")).toHaveCount(0);

		// Frontmatter is collapsed and never becomes a heading.
		const block = page.getByTestId("markdown-frontmatter");
		await expect(block.locator("summary")).toHaveText("Front matter");
		await expect(block).not.toHaveAttribute("open", /.*/);
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
		const bullet = preview.locator("ul > li").first();
		await expect(bullet).toHaveCSS("list-style-type", "disc");
		await expect(preview.locator("ul ul > li").first()).toHaveCSS(
			"list-style-type",
			"circle",
		);
		const numbered = preview.locator("ol > li").first();
		await expect(numbered).toHaveCSS("list-style-type", "decimal");
		// An ordered list that starts at 5 is numbered from 5.
		await expect(preview.locator("ol")).toHaveAttribute("start", "5");
		// The markers sit in a real indent, not flush against the text.
		const padding = await preview
			.locator("ul")
			.first()
			.evaluate((node) => Number.parseFloat(getComputedStyle(node).paddingLeft));
		expect(padding).toBeGreaterThan(10);
	});

	test("split view scrolls both sides together and shows the editor's scrollbar (issue #154)", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const long = Array.from(
			{ length: 200 },
			(_, index) => `## Heading ${index + 1}\n\nParagraph ${index + 1}.\n`,
		).join("\n");
		await openFileTab(page, student, "Long", "LONG.md", long);
		await expect(page.getByTestId("markdown-preview")).toBeVisible({
			timeout: 30_000,
		});
		await page.getByTestId("markdown-mode-split").click();
		await expect(page.getByTestId("markdown-split")).toBeVisible();

		const editor = page.getByTestId("editor-LONG.md");
		await expect(editor.locator(".view-lines")).toContainText("Heading 1", {
			timeout: 60_000,
		});

		// The code side has a scrollbar slider with real height.
		const slider = editor.locator(".scrollbar.vertical .slider").first();
		await expect(slider).toBeVisible();
		const sliderBox = await slider.boundingBox();
		expect(sliderBox?.height ?? 0).toBeGreaterThan(0);
		expect(sliderBox?.width ?? 0).toBeGreaterThan(0);
		// It is on screen, not scrolled out past the right edge of its panel.
		const panel = await page.getByTestId("md-edit-pane").boundingBox();
		expect(sliderBox?.x ?? 0).toBeLessThan((panel?.x ?? 0) + (panel?.width ?? 0));
		await expect(slider).toHaveCSS("opacity", "1");

		const preview = page.getByTestId("markdown-preview");
		await expect(preview).toBeVisible();
		expect(await preview.evaluate((node) => node.scrollTop)).toBe(0);

		// Scrolling the editor moves the preview to the same relative place.
		await editor.locator(".view-line").first().click();
		await page.keyboard.press("Control+End");
		await expect
			.poll(() => firstVisibleLine(page), { timeout: 10_000 })
			.toBeGreaterThan(100);
		await expect
			.poll(() => previewRatio(page), { timeout: 10_000 })
			.toBeGreaterThan(0.8);

		// Scrolling the preview back to the top brings the editor with it.
		await preview.evaluate((node) => {
			node.scrollTop = 0;
		});
		await expect
			.poll(() => firstVisibleLine(page), { timeout: 10_000 })
			.toBeLessThan(5);
	});

	test("Edit shows the raw text, Split shows both, and typing autosaves", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const project = await openMarkdownTab(page, student);
		await expect(page.getByTestId("markdown-preview")).toBeVisible({
			timeout: 30_000,
		});

		await page.getByTestId("markdown-mode-edit").click();
		const lines = page.getByTestId(`editor-${PATH}`).locator(".view-lines");
		await expect(lines).toContainText("title: Project notes", { timeout: 60_000 });
		await expect(lines).toContainText("---");
		// The preview is hidden, not unmounted, so the editor keeps its state.
		await expect(page.getByTestId("markdown-preview")).toBeHidden();

		await page.getByTestId("markdown-mode-split").click();
		await expect(page.getByTestId("markdown-split")).toBeVisible();
		await expect(lines).toContainText("## Ports", { timeout: 30_000 });
		await expect(page.getByTestId("markdown-preview")).toBeVisible();

		// Typing in the editor reaches the preview, and the file still saves.
		await lines.getByText("## Ports").click();
		await page.keyboard.press("End");
		await page.keyboard.type(" and hosts");
		await expect(
			page.getByTestId("markdown-preview").getByRole("heading", {
				name: "Ports and hosts",
			}),
		).toBeVisible({ timeout: 5_000 });

		await expect(page.getByTestId(`file-status-${PATH}`)).toHaveText("Saved", {
			timeout: 15_000,
		});
		await expect
			.poll(async () => readSeededFile(student.workspaceId, project.slug, PATH), {
				timeout: 15_000,
			})
			.toContain("## Ports and hosts");
	});
});

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
