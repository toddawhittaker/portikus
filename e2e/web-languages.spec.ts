import { expect, type Page, test } from "@playwright/test";
import {
	codeHelpStatus,
	editorLines,
	hoverWidget,
	openProjectFiles,
} from "./code-help-helpers";
import { createStudent } from "./helpers";

/**
 * HTML, CSS and JSON code help comes from Monaco's own services, running in
 * the browser, with no server and no status in the editor bar (SPEC.md §13.6).
 */
test.describe("code help for HTML, CSS and JSON", () => {
	test.describe.configure({ timeout: 120_000 });

	/** The language service of every worker the page starts. */
	function watchWorkers(page: Page): string[] {
		const workers: string[] = [];
		page.on("worker", (worker) => {
			const match = /\/(html|css|json)\.worker[^/]*$/.exec(
				new URL(worker.url()).pathname,
			);
			if (match?.[1]) workers.push(match[1]);
		});
		return workers;
	}

	async function open(page: Page, path: string, text: string) {
		const student = await createStudent(page.context());
		await openProjectFiles(page, student, "Web", { [path]: text });
		await expect(editorLines(page, path)).toContainText(text.split("\n")[0] ?? "", {
			timeout: 60_000,
		});
		// No server, so no starting, ready or unavailable state to show.
		await expect(codeHelpStatus(page, path)).toHaveCount(0);
	}

	/** Type on a new last line and ask for completions there. */
	async function completeAtEnd(page: Page, path: string, typed: string) {
		await editorLines(page, path).click();
		await page.keyboard.press("Control+End");
		await page.keyboard.press("Enter");
		await page.keyboard.type(typed);
		await page.keyboard.press("Control+Space");
		return page.locator(".suggest-widget");
	}

	function squiggle(page: Page, path: string) {
		return page.getByTestId(`editor-${path}`).locator(".squiggly-error").first();
	}

	test("HTML offers tag completion and hover, and loads only its own worker", async ({
		page,
	}) => {
		const workers = watchWorkers(page);
		await open(page, "index.html", "<main>hello</main>");
		await page
			.getByTestId("editor-index.html")
			.locator(".view-line span", { hasText: /^main$/ })
			.first()
			.hover();
		await expect(hoverWidget(page)).toContainText("main", { timeout: 20_000 });
		await expect(await completeAtEnd(page, "index.html", "<butt")).toContainText(
			"button",
			{
				timeout: 20_000,
			},
		);
		expect(workers).toContain("html");
		expect(workers).not.toContain("css");
		expect(workers).not.toContain("json");
	});

	test("CSS offers property completion and marks a syntax error", async ({ page }) => {
		const workers = watchWorkers(page);
		await open(page, "style.css", "a { color: red;\n");
		await expect(squiggle(page, "style.css")).toBeVisible({ timeout: 20_000 });
		await expect(await completeAtEnd(page, "style.css", "backgr")).toContainText(
			"background-color",
			{ timeout: 20_000 },
		);
		expect(workers).toEqual(["css"]);
	});

	test("JSON marks a syntax error and never fetches its $schema", async ({ page }) => {
		const schemaRequests: string[] = [];
		// The context sees requests from workers as well as from the page.
		await page.context().route("https://json.schemastore.org/**", (route) => {
			schemaRequests.push(route.request().url());
			return route.abort();
		});
		const workers = watchWorkers(page);
		await open(
			page,
			"package.json",
			'{\n  "$schema": "https://json.schemastore.org/package.json",\n  "name": "demo",,\n}\n',
		);
		await expect(squiggle(page, "package.json")).toBeVisible({ timeout: 20_000 });
		// With no schema there is nothing to complete or describe, so JSON's
		// help is syntax checking alone.
		expect(workers).toEqual(["json"]);
		expect(schemaRequests).toEqual([]);
	});
});
