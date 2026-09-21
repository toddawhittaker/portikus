import { expect, type Locator, type Page, test } from "@playwright/test";
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
	const LONG_PATH = "LONG.md";

	/** A long file where every heading is its own block on a known line. */
	function longDocument(): string {
		return Array.from(
			{ length: 200 },
			(_, index) => `## Heading ${index + 1}\n\nParagraph ${index + 1}.\n`,
		).join("\n");
	}

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

	test("the preview keeps the editor's top line at its own top (issue #229)", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		await openFileTab(page, student, "Long", LONG_PATH, longDocument());
		const preview = page.getByTestId("markdown-preview");
		await expect(preview).toBeVisible({ timeout: 30_000 });

		const editor = page.getByTestId(`editor-${LONG_PATH}`);
		await expect(editor.locator(".view-lines")).toContainText("Heading 1", {
			timeout: 60_000,
		});

		// The code side has a scrollbar slider with real height, inside its
		// own panel rather than past its right edge (issue #154).
		const slider = editor.locator(".scrollbar.vertical .slider").first();
		await expect(slider).toBeVisible();
		const sliderBox = await slider.boundingBox();
		expect(sliderBox?.height ?? 0).toBeGreaterThan(0);
		const panel = await page.getByTestId("md-code-pane").boundingBox();
		expect(sliderBox?.x ?? 0).toBeLessThan((panel?.x ?? 0) + (panel?.width ?? 0));

		expect(await previewScrollTop(page)).toBe(0);

		// Scrolling the editor well down the file: the preview must show the
		// same line at its own top, not merely the same fraction of the way
		// down. Each heading is its own block, so the match is exact enough
		// to name a line.
		await wheelOver(page, editor, 60);
		await expect
			.poll(() => firstVisibleLine(editor), { timeout: 10_000 })
			.toBeGreaterThan(50);
		const editorLine = await firstVisibleLine(editor);
		await expect
			.poll(() => previewTopLine(page), { timeout: 10_000 })
			.toBeGreaterThan(50);
		expect(Math.abs((await previewTopLine(page)) - editorLine)).toBeLessThanOrEqual(2);

		// And the other way round: the preview put at a block halfway down
		// takes the editor to that block's own line.
		const target = await preview.evaluate((node) => {
			const blocks = [...node.querySelectorAll<HTMLElement>("[data-line]")];
			const block = blocks[Math.floor(blocks.length / 2)];
			if (!block) return 0;
			node.scrollTop =
				block.getBoundingClientRect().top -
				node.getBoundingClientRect().top +
				node.scrollTop;
			return Number.parseInt(block.dataset.line ?? "", 10);
		});
		expect(target).toBeGreaterThan(50);
		await expect
			.poll(() => firstVisibleLine(editor), { timeout: 10_000 })
			.toBeGreaterThan(target - 3);
		expect(await firstVisibleLine(editor)).toBeLessThanOrEqual(target + 2);
	});

	test("a wrapped paragraph scrolls both sides a fraction of a line", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		// One paragraph of several hundred words on a single source line. With
		// word wrap on it fills the editor many times over, so a whole-line
		// sync would hold the other side still and then jump (SPEC.md §13.4).
		const paragraph = Array.from({ length: 600 }, (_, index) => `word${index}`).join(
			" ",
		);
		const text = `# Title\n\n${paragraph}\n\n## After\n\nThe end.\n`;
		await openFileTab(page, student, "Wrapped", LONG_PATH, text);
		const preview = page.getByTestId("markdown-preview");
		await expect(preview).toBeVisible({ timeout: 30_000 });

		const editor = page.getByTestId(`editor-${LONG_PATH}`);
		await expect(editor.locator(".view-lines")).toContainText("Title", {
			timeout: 60_000,
		});

		// Wrapping is on for a student who has chosen nothing (issue #270), so
		// the one paragraph line is drawn as many rows.
		await expect
			.poll(() => editor.locator(".view-line").count(), { timeout: 15_000 })
			.toBeGreaterThan(8);

		// A small scroll of the editor, staying inside the paragraph, still
		// moves the preview.
		const previewWas = await previewScrollTop(page);
		await wheelOver(page, editor, 3);
		await expect
			.poll(() => previewScrollTop(page), { timeout: 10_000 })
			.toBeGreaterThan(previewWas);

		// And the other way round: scrolling the preview a little leaves the
		// editor part-way down the paragraph rather than snapped to its start.
		// The row at the top is still one of line 3's wrapped rows but not its
		// first, so the editor sits strictly between where line 3 begins and
		// where line 4 does.
		const rowWas = await topRowText(editor);
		await preview.evaluate((node) => {
			node.scrollTop += 60;
		});
		await expect.poll(() => topRowText(editor), { timeout: 10_000 }).not.toBe(rowWas);
		// Only line 3 holds the "wordN" text, and the row at the top is not
		// the one that line starts with.
		const row = await topRowText(editor);
		expect(row).toContain("word");
		expect(row.startsWith("word0 ")).toBe(false);
	});

	test("the diff pane is side by side with one gutter and one scrollbar", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const text = longDocument();
		const project = await openFileTab(page, student, "Long", LONG_PATH, text);
		await seedGit(student.workspaceId, project.slug, {
			diffs: {
				[LONG_PATH]: {
					status: "M",
					before: `${text}\nOne more line.\n`,
					after: text,
					binary: false,
					tooLarge: false,
				},
			},
		});
		await page.getByTestId(`file-view-diff-${LONG_PATH}`).click();
		const diff = page
			.getByTestId(`diff-editor-${LONG_PATH}`)
			.locator(".monaco-diff-editor");
		await expect(diff).toBeVisible({ timeout: 60_000 });
		await expect(diff).toHaveClass(/side-by-side/);
		await expect(diff.locator(".editor.original .margin")).toHaveCount(1);
		await expect(diff.locator(".editor.modified .margin")).toHaveCount(1);
		await expect(diff.locator(".diffOverview")).toHaveCount(0);
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

	test("Diff replaces the whole Markdown tab, and back (issue #218)", async ({
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
		await expect(page.getByTestId("markdown-split")).toBeVisible();

		await page.getByTestId(`file-view-diff-${PATH}`).click();
		const diff = page.getByTestId(`diff-editor-${PATH}`);
		await expect(diff.locator(".monaco-diff-editor")).toBeVisible({ timeout: 60_000 });
		await expect(diff).toContainText("Second line.");
		// The split is gone: the diff has the tab to itself.
		await expect(page.getByTestId("markdown-split")).toBeHidden();
		await expect(page.getByTestId("markdown-preview")).toBeHidden();

		await page.getByTestId(`file-view-diff-${PATH}`).click();
		await expect(page.getByTestId(`diff-pane-${PATH}`)).toHaveCount(0);
		await expect(page.getByTestId("markdown-split")).toBeVisible();
		await expect(page.getByTestId("markdown-preview")).toBeVisible();
	});
});

/** Where the preview is scrolled to, in pixels. */
function previewScrollTop(page: Page): Promise<number> {
	return page.getByTestId("markdown-preview").evaluate((node) => node.scrollTop);
}

/** The source line of the topmost block the preview is showing. */
function previewTopLine(page: Page): Promise<number> {
	return page.getByTestId("markdown-preview").evaluate((node) => {
		const top = node.getBoundingClientRect().top;
		for (const block of node.querySelectorAll<HTMLElement>("[data-line]")) {
			if (block.getBoundingClientRect().bottom > top + 1) {
				return Number.parseInt(block.dataset.line ?? "", 10);
			}
		}
		return 0;
	});
}

/** Scroll with the wheel over one editor, the way a student would. */
async function wheelOver(page: Page, target: Locator, steps: number): Promise<void> {
	const box = await target.boundingBox();
	await page.mouse.move(
		(box?.x ?? 0) + (box?.width ?? 0) / 2,
		(box?.y ?? 0) + (box?.height ?? 0) / 2,
	);
	for (let step = 0; step < steps; step += 1) {
		await page.mouse.wheel(0, 200);
	}
}

/** The topmost line number one Monaco editor is showing. */
function firstVisibleLine(editor: Locator): Promise<number> {
	return editor
		.locator(".margin-view-overlays")
		.first()
		.evaluate((node) => {
			const numbers = [...node.querySelectorAll(".line-numbers")]
				.map((line) => Number.parseInt(line.textContent ?? "", 10))
				.filter((value) => Number.isFinite(value));
			return numbers.length > 0 ? Math.min(...numbers) : 0;
		});
}

/** The text of the topmost row one Monaco editor is drawing. */
function topRowText(editor: Locator): Promise<string> {
	return editor
		.locator(".view-lines")
		.first()
		.evaluate((node) => {
			const top = node.getBoundingClientRect().top;
			let best: { distance: number; text: string } | null = null;
			for (const row of node.querySelectorAll<HTMLElement>(".view-line")) {
				const distance = Math.abs(row.getBoundingClientRect().top - top);
				if (!best || distance < best.distance) {
					best = { distance, text: row.textContent ?? "" };
				}
			}
			return best?.text ?? "";
		});
}
