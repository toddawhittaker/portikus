import { expect, test } from "@playwright/test";
import { createStudent, expectNoViolations, openFileTab } from "./helpers";

/**
 * Fenced code in the Markdown preview is highlighted by Monaco's own
 * tokenizer (SPEC.md §13.4). The student's file is untrusted and the preview
 * runs on the app's origin, so markup inside a fence must stay text
 * (SPEC.md §24.2, §24.3), and every token colour must stay readable on the
 * block's background in both themes (SPEC.md §25.8).
 */
const README = [
	"# Example",
	"",
	"```js",
	"// add two numbers",
	"const sum = (a, b) => a + b;",
	'console.log("total", sum(1, 2));',
	"```",
	"",
	"```html",
	'<img src=x onerror="window.fenceRan = 1">',
	"```",
	"",
	"```python",
	"def greet(name):",
	'    return f"Hello, {name}"  # a comment',
	"```",
	"",
	"```nosuchlanguage",
	"left as it is",
	"```",
	"",
].join("\n");

for (const scheme of ["light", "dark"] as const) {
	test(`fenced code is highlighted, safe and readable (${scheme})`, async ({
		page,
		context,
	}) => {
		test.setTimeout(90_000);
		await page.emulateMedia({ colorScheme: scheme });
		const student = await createStudent(context);
		await openFileTab(page, student, "Fences", "README.md", README);

		const preview = page.getByTestId("markdown-preview");
		const blocks = preview.locator("pre code");
		await expect(blocks).toHaveCount(4, { timeout: 30_000 });
		await expect(preview.locator("pre code[data-colorized]")).toHaveCount(3, {
			timeout: 30_000,
		});

		// Highlighting changes the colours, not the text.
		await expect(blocks.nth(0)).toHaveText(
			[
				"// add two numbers",
				"const sum = (a, b) => a + b;",
				'console.log("total", sum(1, 2));',
				"",
			].join("\n"),
		);
		expect(await blocks.nth(0).locator("span[class^='mtk']").count()).toBeGreaterThan(
			3,
		);
		// The comment and the keyword are coloured differently.
		const colours = await blocks
			.nth(0)
			.locator("span")
			.evaluateAll(
				(spans) => new Set(spans.map((span) => getComputedStyle(span).color)).size,
			);
		expect(colours).toBeGreaterThan(2);

		// Markup in a fence is shown as its text and never becomes an element.
		await expect(blocks.nth(1)).toHaveText(
			'<img src=x onerror="window.fenceRan = 1">\n',
		);
		await expect(preview.locator("img")).toHaveCount(0);
		expect(await page.evaluate(() => (window as { fenceRan?: number }).fenceRan)).toBe(
			undefined,
		);
		// Every element inside a highlighted block is a token span.
		const others = await preview
			.locator("pre code[data-colorized] *")
			.evaluateAll(
				(nodes) =>
					nodes.filter(
						(node) =>
							node.tagName !== "SPAN" ||
							!/^mtk\d+( mtk[ibus])*$/.test(node.getAttribute("class") ?? "") ||
							node.attributes.length !== 1,
					).length,
			);
		expect(others).toBe(0);

		// A language Monaco does not know stays plain.
		await expect(blocks.nth(3)).not.toHaveAttribute("data-colorized");
		await expect(blocks.nth(3)).toHaveText("left as it is\n");

		await expectNoViolations(page, '[data-testid="markdown-preview"]');
	});
}

test("highlighting follows a theme change", async ({ page, context }) => {
	test.setTimeout(90_000);
	await page.emulateMedia({ colorScheme: "light" });
	const student = await createStudent(context);
	await openFileTab(page, student, "Fence theme", "README.md", README);
	const keyword = page
		.getByTestId("markdown-preview")
		.locator("pre code[data-colorized]")
		.first()
		.locator("span", { hasText: "const" });
	await expect(keyword).toBeVisible({ timeout: 30_000 });
	const light = await keyword.evaluate((span) => getComputedStyle(span).color);
	await page.emulateMedia({ colorScheme: "dark" });
	await expect
		.poll(() => keyword.evaluate((span) => getComputedStyle(span).color))
		.not.toBe(light);
	await expectNoViolations(page, '[data-testid="markdown-preview"]');
});
