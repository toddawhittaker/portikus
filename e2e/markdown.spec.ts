import { expect, type Page, test } from "@playwright/test";
import {
	createStudent,
	openFileTab,
	readSeededFile,
	type TestProject,
	type TestStudent,
} from "./helpers";

/**
 * Markdown tabs: the Code, Rich and Split views (SPEC.md §13.2, §13.4, issue
 * #155). Both sides are editable and edit the same text, and everything a
 * student types reaches the file through the tab's ordinary save path.
 */
test.describe("markdown tab", () => {
	// Monaco and the rich editor are large chunks the dev server transforms on
	// first use.
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

	test("a Markdown file opens in the rich view, with a toolbar", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		await openMarkdownTab(page, student);

		const rich = page.getByTestId("markdown-rich");
		await expect(rich).toBeVisible({ timeout: 30_000 });
		await expect(page.getByTestId("markdown-mode-rich")).toHaveAttribute(
			"aria-pressed",
			"true",
		);

		await expect(rich.getByRole("heading", { name: "Ports" })).toBeVisible();
		await expect(rich.locator("table")).toBeVisible();
		await expect(rich.getByRole("cell", { name: "3000" })).toBeVisible();

		// The toolbar's basics are there and the document is editable.
		await expect(rich.getByLabel("Bold")).toBeVisible();
		await expect(rich.getByLabel("Italic")).toBeVisible();
		await expect(rich.locator(".pk-rich-markdown-body")).toHaveAttribute(
			"contenteditable",
			"true",
		);

		// The script tag never becomes an element the browser ran.
		await expect(rich.locator("script")).toHaveCount(0);
	});

	test("lists render with their markers (issue #154)", async ({ page, context }) => {
		const student = await createStudent(context);
		await openFileTab(
			page,
			student,
			"Lists",
			"LIST.md",
			"- one\n- two\n  - nested\n\n1. first\n2. second\n",
		);

		const rich = page.getByTestId("markdown-rich");
		await expect(rich).toBeVisible({ timeout: 30_000 });
		const bullet = rich.locator("ul > li").first();
		await expect(bullet).toHaveCSS("list-style-type", "disc");
		await expect(rich.locator("ul ul > li").first()).toHaveCSS(
			"list-style-type",
			"circle",
		);
		await expect(rich.locator("ol > li").first()).toHaveCSS(
			"list-style-type",
			"decimal",
		);
		// The markers sit in a real indent, not flush against the text.
		const padding = await rich
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
		await expect(page.getByTestId("markdown-rich")).toBeVisible({
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
		const panel = await page.getByTestId("md-code-pane").boundingBox();
		expect(sliderBox?.x ?? 0).toBeLessThan((panel?.x ?? 0) + (panel?.width ?? 0));
		await expect(slider).toHaveCSS("opacity", "1");

		const rich = page.getByTestId("markdown-rich");
		await expect(rich).toBeVisible();
		expect(await rich.evaluate((node) => node.scrollTop)).toBe(0);

		// Scrolling the editor moves the rich side to the same relative place.
		await editor.locator(".view-line").first().click();
		await page.keyboard.press("Control+End");
		await expect
			.poll(() => firstVisibleLine(page), { timeout: 10_000 })
			.toBeGreaterThan(100);
		await expect.poll(() => richRatio(page), { timeout: 10_000 }).toBeGreaterThan(0.8);

		// Scrolling the rich side back to the top brings the editor with it.
		await rich.evaluate((node) => {
			node.scrollTop = 0;
		});
		await expect
			.poll(() => firstVisibleLine(page), { timeout: 10_000 })
			.toBeLessThan(5);
	});

	test("Code shows the raw text, Split shows both, and typing autosaves", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const project = await openMarkdownTab(page, student);
		await expect(page.getByTestId("markdown-rich")).toBeVisible({
			timeout: 30_000,
		});

		await page.getByTestId("markdown-mode-code").click();
		const lines = page.getByTestId(`editor-${PATH}`).locator(".view-lines");
		await expect(lines).toContainText("title: Project notes", { timeout: 60_000 });
		await expect(lines).toContainText("---");
		await expect(page.getByTestId("markdown-rich")).toBeHidden();

		await page.getByTestId("markdown-mode-split").click();
		await expect(page.getByTestId("markdown-split")).toBeVisible();
		await expect(lines).toContainText("## Ports", { timeout: 30_000 });
		await expect(page.getByTestId("markdown-rich")).toBeVisible();

		// Typing in the code side reaches the rich side, and the file saves.
		await lines.getByText("## Ports").click();
		await page.keyboard.press("End");
		await page.keyboard.type(" and hosts");
		await expect(
			page.getByTestId("markdown-rich").getByRole("heading", {
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

	test("typing in the rich view saves Markdown to the file (issue #155)", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const project = await openFileTab(
			page,
			student,
			"Rich",
			"NOTES.md",
			"# Notes\n\nFirst line.\n",
		);
		const rich = page.getByTestId("markdown-rich");
		await expect(rich).toBeVisible({ timeout: 30_000 });

		await rich.getByText("First line.").click();
		await page.keyboard.press("End");
		await page.keyboard.type(" Second sentence.");

		await expect(page.getByTestId("file-status-NOTES.md")).toHaveText("Saved", {
			timeout: 20_000,
		});
		await expect
			.poll(async () => readSeededFile(student.workspaceId, project.slug, "NOTES.md"), {
				timeout: 20_000,
			})
			.toBe("# Notes\n\nFirst line. Second sentence.\n");
	});

	test("a README with a badge and an HTML comment shows all its text, and typing still saves", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const before = [
			"# Project",
			"",
			"![build](https://img.example.invalid/badge.svg)",
			"",
			"<!-- written by a coding agent -->",
			"",
			"How to run it.",
			"",
		].join("\n");
		const project = await openFileTab(page, student, "Readme", "DOC.md", before);
		const rich = page.getByTestId("markdown-rich");
		await expect(rich).toBeVisible({ timeout: 30_000 });

		// Everything after the badge and the comment is on screen: the whole
		// point of the fix. The comment shows as its own source, not as markup.
		await expect(rich.getByRole("heading", { name: "Project" })).toBeVisible();
		await expect(rich).toContainText("<!-- written by a coding agent -->");
		await expect(rich.getByText("How to run it.")).toBeVisible();
		// The badge is drawn as an image. Its address does not resolve in a
		// test, so only its alt text is checked here; the address allowlist is
		// covered by the unit tests.
		await expect(rich.locator("img")).toHaveAttribute("alt", "build");
		// The tab did not have to fall back to the code view.
		await expect(page.getByTestId("rich-unsupported")).toHaveCount(0);

		// And keystrokes after the comment reach the file.
		await rich.getByText("How to run it.").click();
		await page.keyboard.press("End");
		await page.keyboard.type(" Read on.");

		await expect(page.getByTestId("file-status-DOC.md")).toHaveText("Saved", {
			timeout: 20_000,
		});
		await expect
			.poll(async () => readSeededFile(student.workspaceId, project.slug, "DOC.md"), {
				timeout: 20_000,
			})
			.toBe(before.replace("How to run it.", "How to run it. Read on."));
	});

	test("the toolbar's bold button wraps the selection in asterisks (issue #155)", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const project = await openFileTab(
			page,
			student,
			"Bold",
			"BOLD.md",
			"Make important stand out.\n",
		);
		const rich = page.getByTestId("markdown-rich");
		await expect(rich).toBeVisible({ timeout: 30_000 });

		// Double-clicking a word selects it, which is what the button acts on.
		await rich.getByText("Make important stand out.").dblclick();
		await rich.getByLabel("Bold").click();

		await expect(page.getByTestId("file-status-BOLD.md")).toHaveText("Saved", {
			timeout: 20_000,
		});
		await expect
			.poll(async () => readSeededFile(student.workspaceId, project.slug, "BOLD.md"), {
				timeout: 20_000,
			})
			.toContain("**");
	});
});

/** How far down its own scrollable range the rich side sits, from 0 to 1. */
function richRatio(page: Page): Promise<number> {
	return page
		.getByTestId("markdown-rich")
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
