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
