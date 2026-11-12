import { expect, type Locator, type Page, test } from "@playwright/test";
import {
	contrast,
	createProject,
	createStudent,
	expectNoViolations,
	seedFile,
	workspacePath,
} from "./helpers";

/**
 * The Files pane's file-type icons (SPEC.md §11.2): a glyph per family and a
 * tagged page per language, each lightly tinted. Every tint is non-text
 * colour that must meet 3:1 on the row behind it (§25.8), whether the row is
 * plain, hovered, focused or selected, in both themes.
 */

/** One file of every family and language, with the icon it should draw. */
const FILES = [
	["src/main.py", "file-python"],
	["src/Main.java", "file-java"],
	["src/app.js", "file-javascript"],
	["src/app.ts", "file-typescript"],
	["src/main.c", "file-c"],
	["src/main.cpp", "file-cpp"],
	["src/schema.sql", "file-sql"],
	["src/run.sh", "file-shell"],
	["src/main.go", "file-go"],
	["src/main.rs", "file-rust"],
	["src/Program.cs", "file-csharp"],
	["src/app.rb", "file-ruby"],
	["src/index.php", "file-php"],
	["src/Main.kt", "file-kotlin"],
	["src/App.swift", "file-swift"],
	[".env", "file-key"],
	["Cargo.lock", "file-lock"],
	["README.md", "file-markdown"],
	["Song.mp3", "file-audio"],
	["clip.mp4", "file-video"],
	["config.ini", "file-config"],
	["data.json", "file-data"],
	["essay.docx", "file-text"],
	["font.woff2", "file-font"],
	["grades.xlsx", "file-sheet"],
	["index.html", "file-web"],
	["lab.ipynb", "file-notebook"],
	["logo.png", "file-image"],
	["notes", "file"],
	["report.pdf", "file-pdf"],
	["styles.css", "file-style"],
	["work.zip", "file-archive"],
] as const;

/** Folders too: lib stays closed and src is opened. */
const FOLDERS = [
	["lib", "folder"],
	["src", "folder-open"],
] as const;

const ROWS = [...FOLDERS, ...FILES];

async function openProject(page: Page, name: string): Promise<void> {
	const student = await createStudent(page.context());
	const project = await createProject(student.workspaceId, { name });
	await seedFile(student.workspaceId, project.slug, "lib/keep.txt", "x\n");
	for (const [path] of FILES) {
		await seedFile(student.workspaceId, project.slug, path, "x\n");
	}
	await page.goto(workspacePath(student.workspaceId, project.id));
	await expect(page.getByTestId("file-tree")).toBeVisible({ timeout: 15_000 });
	// Opened from the keyboard, so nothing is selected yet.
	await row(page, "src").focus();
	await page.keyboard.press("ArrowRight");
	await expect(row(page, "src/main.py")).toBeVisible();
	await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
	await page.mouse.move(0, 0);
}

function row(page: Page, path: string): Locator {
	return page.getByTestId(`file-row-${path}`);
}

function icon(page: Page, path: string): Locator {
	return row(page, path).locator(
		'> .pk-tree-row .pk-icon:is([data-icon^="file"], [data-icon^="folder"])',
	);
}

/**
 * The icon's colour and the first opaque background behind it, read through
 * a canvas so color-mix comes back as plain rgb().
 */
async function colours(locator: Locator): Promise<[string, string]> {
	return locator.evaluate((element) => {
		const context = document.createElement("canvas").getContext("2d", {
			willReadFrequently: true,
		});
		if (!context) throw new Error("no canvas");
		const rgba = (css: string) => {
			context.clearRect(0, 0, 1, 1);
			context.fillStyle = css;
			context.fillRect(0, 0, 1, 1);
			return Array.from(context.getImageData(0, 0, 1, 1).data);
		};
		let node: Element | null = element;
		let bg = rgba("transparent");
		while (node) {
			bg = rgba(getComputedStyle(node).backgroundColor);
			if (bg[3] === 255) break;
			node = node.parentElement;
		}
		const fg = rgba(getComputedStyle(element).color);
		return [`rgb(${fg.slice(0, 3).join(",")})`, `rgb(${bg.slice(0, 3).join(",")})`];
	});
}

async function expectContrast(page: Page, path: string, state: string): Promise<void> {
	const [fg, bg] = await colours(icon(page, path));
	expect(contrast(fg, bg), `${path} ${state}`).toBeGreaterThanOrEqual(3);
}

for (const colorScheme of ["dark", "light"] as const) {
	test.describe(`Files pane icons (${colorScheme})`, () => {
		test.beforeEach(async ({ page }) => {
			await page.emulateMedia({ colorScheme });
		});

		test("every family and language has its icon, tinted", async ({ page }) => {
			await openProject(page, `Icons ${colorScheme}`);
			for (const [path, name] of ROWS) {
				await expect(icon(page, path), path).toHaveAttribute("data-icon", name);
			}
			// A source file's page carries its language as a word.
			await expect(icon(page, "src/main.py").locator("text")).toHaveText("py");
			// Colour on every icon: none is left in the plain muted ink.
			const muted = await page.evaluate(() => {
				const probe = document.createElement("span");
				probe.style.color = "var(--ink-muted)";
				document.body.append(probe);
				const color = getComputedStyle(probe).color;
				probe.remove();
				return color;
			});
			for (const [path] of ROWS) {
				await expect(icon(page, path), path).not.toHaveCSS("color", muted);
			}
			await expectNoViolations(page, '[data-testid="file-tree"]');
		});

		test("each tint meets 3:1 on plain, hovered, focused and selected rows", async ({
			page,
		}) => {
			await openProject(page, `Contrast ${colorScheme}`);

			for (const [path] of ROWS) await expectContrast(page, path, "plain");

			for (const [path] of ROWS) {
				await row(page, path).locator("> .pk-tree-row .pk-tree-name").hover();
				await expectContrast(page, path, "hovered");
			}
			await page.mouse.move(0, 0);

			// Walk the tree from the keyboard; each focused row wears its tone
			// and the focus ring.
			await row(page, "lib").focus();
			const seen = new Set<string>();
			for (let step = 0; step < ROWS.length; step++) {
				if (step > 0) await page.keyboard.press("ArrowDown");
				const current = page.locator(
					'[data-testid="file-tree"] [role="treeitem"]:focus',
				);
				const path = (await current.getAttribute("data-testid"))?.replace(
					"file-row-",
					"",
				);
				if (!path) throw new Error("no current row");
				seen.add(path);
				await expectContrast(page, path, "focused");
			}
			expect([...seen].sort()).toEqual(ROWS.map(([path]) => path).sort());

			// A plain click starts a fresh selection, then Ctrl-click adds each
			// other row to it without opening it.
			for (const [index, [path]] of ROWS.entries()) {
				await row(page, path)
					.locator("> .pk-tree-row .pk-tree-name")
					.click({ modifiers: index === 0 ? [] : ["Control"] });
				await expect(row(page, path)).toHaveAttribute("aria-selected", "true");
				await page.mouse.move(0, 0);
				await expectContrast(page, path, "selected");
			}

			await expectNoViolations(page, '[data-testid="file-tree"]');
		});
	});
}
