import { expect, type Page, test } from "@playwright/test";
import { createStudent, expectNoViolations, openFileTab, seedGit } from "./helpers";

/**
 * A file pane switched to Diff keeps the editor's zoom controls and its zoom:
 * one zoom per file, shared by Edit and Diff (SPEC.md §13.1).
 */
test.describe("diff zoom", () => {
	// Monaco is a large chunk the dev server transforms on first use, so the
	// first run of this file is much slower than the rest of the suite.
	test.describe.configure({ timeout: 120_000 });

	const PATH = "src/app.ts";
	const CONTENT = "const answer = 42;\n";

	async function openPane(page: Page) {
		const student = await createStudent(page.context());
		const project = await openFileTab(page, student, "Diff zoom", PATH, CONTENT);
		await seedGit(student.workspaceId, project.slug, {
			diffs: {
				[PATH]: {
					status: "M",
					before: "const answer = 1;\n",
					after: CONTENT,
					binary: false,
					tooLarge: false,
				},
			},
		});
		await expect(editor(page).locator(".view-lines")).toContainText(
			"const answer = 42;",
			{ timeout: 60_000 },
		);
	}

	const editor = (page: Page) => page.getByTestId(`editor-${PATH}`);
	const diff = (page: Page) => page.getByTestId(`diff-editor-${PATH}`);
	const editorZoom = (page: Page) => page.getByTestId(`editor-zoom-${PATH}`);
	const diffZoom = (page: Page) => page.getByTestId(`diff-zoom-${PATH}`);

	async function showDiff(page: Page) {
		await page.getByTestId(`file-view-diff-${PATH}`).click();
		await expect(diff(page).locator(".monaco-diff-editor")).toBeVisible({
			timeout: 60_000,
		});
	}

	/** The font size of each side of the diff. */
	function diffFontSizes(page: Page) {
		return diff(page)
			.locator(".view-lines")
			.evaluateAll((nodes) => nodes.map((node) => getComputedStyle(node).fontSize));
	}

	test("the diff has the zoom controls and opens at the editor's zoom", async ({
		page,
	}) => {
		await openPane(page);
		const startSize = await editor(page)
			.locator(".view-lines")
			.evaluate((node) => getComputedStyle(node).fontSize);

		await editor(page).getByLabel("Zoom in").click();
		await editor(page).getByLabel("Zoom in").click();
		await expect(editorZoom(page)).toHaveText("120%");
		const zoomedSize = await editor(page)
			.locator(".view-lines")
			.evaluate((node) => getComputedStyle(node).fontSize);
		expect(zoomedSize).not.toBe(startSize);

		await showDiff(page);
		await expect(diffZoom(page)).toHaveText("120%");
		await expect(diff(page).getByLabel("Zoom out")).toBeVisible();
		await expect(diff(page).getByLabel("Zoom in")).toBeVisible();
		await expect(diff(page).getByRole("button", { name: "Reset" })).toBeVisible();
		// Both sides of the diff are at the editor's size.
		expect(await diffFontSizes(page)).toEqual([zoomedSize, zoomedSize]);
	});

	test("a zoom made in the diff carries back to the editor", async ({ page }) => {
		await openPane(page);
		await showDiff(page);
		await expect(diffZoom(page)).toHaveText("100%");

		await diff(page).getByLabel("Zoom in").click();
		await expect(diffZoom(page)).toHaveText("110%");
		const [original, modified] = await diffFontSizes(page);
		expect(original).toBe(modified);
		expect(original).not.toBe("14px");

		await page.getByTestId(`file-view-edit-${PATH}`).click();
		await expect(editorZoom(page)).toHaveText("110%");
		await expect(editor(page).locator(".view-lines")).toHaveCSS(
			"font-size",
			original ?? "",
		);

		// And the diff opened again is still at that zoom.
		await showDiff(page);
		await expect(diffZoom(page)).toHaveText("110%");
	});

	test("the zoom keys, the wheel and Reset work on the diff", async ({ page }) => {
		await openPane(page);
		await showDiff(page);

		await diff(page).locator(".modified .view-lines").click();
		await page.keyboard.press("Control+Shift+Equal");
		await expect(diffZoom(page)).toHaveText("110%");
		await page.keyboard.press("Control+Shift+Minus");
		await page.keyboard.press("Control+Shift+Minus");
		await expect(diffZoom(page)).toHaveText("90%");
		await page.keyboard.press("Control+0");
		await expect(diffZoom(page)).toHaveText("100%");

		// The earlier side takes the keys too.
		await diff(page).locator(".original .view-lines").click();
		await page.keyboard.press("Control+Shift+Equal");
		await expect(diffZoom(page)).toHaveText("110%");

		// Ctrl with the wheel over the diff zooms it, and the diff takes the
		// event so the browser cannot zoom the page with it.
		const prevented = await diff(page)
			.locator(".pk-editor-host")
			.evaluate((node) => {
				const event = new WheelEvent("wheel", {
					deltaY: -120,
					ctrlKey: true,
					bubbles: true,
					cancelable: true,
				});
				node.dispatchEvent(event);
				return event.defaultPrevented;
			});
		expect(prevented).toBe(true);
		await expect(diffZoom(page)).toHaveText("120%");

		// SPEC.md §25.8: the diff's bar adds no accessibility violation.
		await expectNoViolations(
			page,
			`[data-testid="diff-editor-${PATH}"] .pk-editor-bar`,
		);

		await diff(page).getByRole("button", { name: "Reset" }).click();
		await expect(diffZoom(page)).toHaveText("100%");
		await page.getByTestId(`file-view-edit-${PATH}`).click();
		await expect(editorZoom(page)).toHaveText("100%");
	});
});
