import { expect, type Page, test } from "@playwright/test";
import {
	codeHelpStatus,
	editorLines,
	holdCodeHelpSwitch,
	hoverWidget,
	openProjectFiles,
	watchLanguageServers,
} from "./code-help-helpers";
import { createStudent, expectNoViolations, query } from "./helpers";

/**
 * The code-help status on the editor bar and the hover, in both themes, and
 * the two buttons from the keyboard (SPEC.md §13.6, §25.8).
 */
const PATH = "app.py";

for (const colorScheme of ["light", "dark"] as const) {
	test.describe(`code help accessibility (${colorScheme})`, () => {
		test.describe.configure({ timeout: 120_000 });
		holdCodeHelpSwitch(test);

		test.beforeEach(async ({ page }) => {
			await page.emulateMedia({ colorScheme });
		});

		/** A student whose saved appearance is this theme, so the page sets data-theme. */
		async function themedStudent(page: Page) {
			const student = await createStudent(page.context());
			await query(
				"update users set editor_settings = editor_settings || $1::jsonb where id = $2",
				[JSON.stringify({ appearance: colorScheme }), student.userId],
			);
			return student;
		}

		async function openReady(page: Page) {
			const student = await themedStudent(page);
			const wire = await watchLanguageServers(page);
			await openProjectFiles(page, student, "Access", { [PATH]: "answer = 42\n" });
			await expect(page.locator("html")).toHaveAttribute("data-theme", colorScheme, {
				timeout: 15_000,
			});
			await expect(editorLines(page, PATH)).toContainText("answer", {
				timeout: 60_000,
			});
			await expect(codeHelpStatus(page, PATH)).toHaveText("Code help ready", {
				timeout: 30_000,
			});
			return wire;
		}

		const bar = `[data-testid="editor-${PATH}"] .pk-editor-bar`;

		test("every state of the editor bar's status passes axe", async ({ page }) => {
			const wire = await openReady(page);
			const status = codeHelpStatus(page, PATH);
			// A live region, so a change of state is announced.
			await expect(status).toHaveAttribute("role", "status");
			await expectNoViolations(page, bar);

			const states = [
				[4414, "crashed", "Code help stopped", "Restart"],
				[
					4412,
					"replaced by another window",
					"Code help is on in another window",
					"Use here",
				],
				[4415, "unavailable", "Code help unavailable", "Restart"],
			] as const;
			for (const [code, reason, text, action] of states) {
				await wire.close("python", code, reason);
				await expect(status).toHaveText(text);
				await expect(
					page.getByRole("button", { name: action, exact: true }),
				).toBeVisible();
				await expectNoViolations(page, bar);
				await page.getByRole("button", { name: action, exact: true }).click();
				await expect(status).toHaveText("Code help ready", { timeout: 30_000 });
			}

			await wire.close("python", 4414, "crashed: may have run out of memory");
			await expect(status).toHaveText(
				"Code help stopped. It may have run out of memory.",
			);
			await expectNoViolations(page, bar);
		});

		test("the too-large notice passes axe", async ({ page }) => {
			const student = await themedStudent(page);
			await watchLanguageServers(page);
			const big = `${"a".repeat(63)}\n`.repeat(8193);
			await openProjectFiles(page, student, "Access large", { [PATH]: big });
			await expect(codeHelpStatus(page, PATH)).toHaveText(
				"Code help is off for files over 512 KB",
				{ timeout: 60_000 },
			);
			await expectNoViolations(page, bar);
		});

		test("the server's hover passes axe", async ({ page }) => {
			const wire = await openReady(page);
			// The whole line, so the hover on the last word carries no diagnostic.
			wire.rewrite(({ method }) =>
				method === "textDocument/hover"
					? {
							contents: { kind: "markdown", value: "**scripted hover**" },
							range: {
								start: { line: 0, character: 0 },
								end: { line: 0, character: 11 },
							},
						}
					: undefined,
			);
			await page
				.getByTestId(`editor-${PATH}`)
				.locator(".view-line")
				.first()
				.hover({ position: { x: 90, y: 6 } });
			await expect(hoverWidget(page)).toContainText("scripted hover");
			await expect(hoverWidget(page)).not.toContainText("scripted warning");
			await expectNoViolations(page, ".monaco-hover:not(.hidden)");
		});

		test("a diagnostic's hover passes axe", async ({ page }) => {
			// Monaco draws the diagnostic's source ("fake", "pyright") at 60% opacity,
			// which is under 4.5:1 on the light theme (SPEC.md §25.8). Known gap: this
			// passes as an expected failure until the editor styles that text.
			test.fail(colorScheme === "light", "diagnostic source text fails contrast");
			await openReady(page);
			await page
				.getByTestId(`editor-${PATH}`)
				.locator(".view-line")
				.first()
				.hover({ position: { x: 2, y: 6 } });
			await expect(hoverWidget(page)).toContainText("scripted warning");
			await expectNoViolations(page, ".monaco-hover:not(.hidden)");
		});

		for (const [name, code, reason, text, key] of [
			["Restart", 4414, "crashed", "Code help stopped", "Enter"],
			["Restart", 4415, "unavailable", "Code help unavailable", "Space"],
			[
				"Use here",
				4412,
				"replaced by another window",
				"Code help is on in another window",
				"Enter",
			],
		] as const) {
			test(`${name} is reached and used from the keyboard (${text}, ${key})`, async ({
				page,
			}) => {
				const wire = await openReady(page);
				await wire.close("python", code, reason);
				await expect(codeHelpStatus(page, PATH)).toHaveText(text);

				// The button sits right after the status and before the zoom buttons.
				await page.getByRole("button", { name: "Zoom out" }).focus();
				await page.keyboard.press("Shift+Tab");
				const button = page.getByRole("button", { name, exact: true });
				await expect(button).toBeFocused();
				await expect(button).toHaveCSS("outline-style", /solid|auto/);
				await page.keyboard.press("Tab");
				await expect(page.getByRole("button", { name: "Zoom out" })).toBeFocused();
				await page.keyboard.press("Shift+Tab");

				await page.keyboard.press(key);
				await expect(codeHelpStatus(page, PATH)).toHaveText("Code help ready", {
					timeout: 30_000,
				});
				expect(wire.opened("python")).toBe(2);
			});
		}
	});
}
