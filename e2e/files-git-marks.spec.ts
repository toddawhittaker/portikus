import { expect, type Locator, type Page, test } from "@playwright/test";
import {
	createProject,
	createStudent,
	expectNoViolations,
	seedFile,
	seedGit,
	workspacePath,
} from "./helpers";

/**
 * The Files pane's Git marks and file-type icons (SPEC.md §11.2, §12.1,
 * §12.6, §12.8): a coloured letter per changed file, a folder mark coloured
 * by the most important change below it, the same words on hover and for a
 * screen reader, and marks that meet 4.5:1 and never rest on colour alone
 * (§25.8), in both themes.
 */

const entries = [
	{ path: "README.md", x: ".", y: "M", unmerged: false },
	{ path: "notes.txt", x: "?", y: "?", unmerged: false },
	{ path: ".portikus/state.json", x: "?", y: "?", unmerged: false },
	{ path: "app/main.ts", x: ".", y: "M", unmerged: false },
	{ path: "app/extra.ts", x: "?", y: "?", unmerged: false },
	{ path: "old/gone.ts", x: ".", y: "D", unmerged: false },
	{ path: "old/new.ts", x: "?", y: "?", unmerged: false },
	{ path: "merge/clash.ts", x: "U", y: "U", unmerged: true },
	{ path: "merge/edit.ts", x: ".", y: "M", unmerged: false },
];

const files = [
	"README.md",
	"notes.txt",
	"index.html",
	"styles.css",
	".portikus/state.json",
	"app/main.ts",
	"app/extra.ts",
	"old/keep.ts",
	"old/new.ts",
	"merge/clash.ts",
	"merge/edit.ts",
];

async function openProject(page: Page, name: string): Promise<void> {
	const student = await createStudent(page.context());
	const project = await createProject(student.workspaceId, { name });
	for (const path of files) {
		await seedFile(student.workspaceId, project.slug, path, "x\n");
	}
	await seedGit(student.workspaceId, project.slug, {
		status: {
			repo: true,
			branch: "main",
			detached: false,
			upstream: "origin/main",
			ahead: 0,
			behind: 0,
			conflicts: 1,
			entries,
			ignored: [],
			truncated: false,
		},
	});
	await page.goto(workspacePath(student.workspaceId, project.id));
	await expect(page.getByTestId("file-tree")).toBeVisible({ timeout: 15_000 });
	await expect(row(page, "README.md")).toHaveAttribute("data-git", "modified");
}

function row(page: Page, path: string): Locator {
	return page.getByTestId(`file-row-${path}`);
}

/** The mark drawn on a row itself, not on a row nested under it. */
function mark(page: Page, path: string, selector: string): Locator {
	return row(page, path).locator(`> .pk-tree-row ${selector}`);
}

/**
 * The contrast of an element's text colour against the first opaque
 * background behind it. Colours are read through a canvas so any CSS colour
 * the browser computes, color-mix included, comes back as sRGB bytes.
 */
async function contrast(locator: Locator): Promise<number> {
	return locator.evaluate((element) => {
		const context = document.createElement("canvas").getContext("2d", {
			willReadFrequently: true,
		});
		if (!context) throw new Error("no canvas");
		function rgba(css: string): [number, number, number, number] {
			if (!context) throw new Error("no canvas");
			context.clearRect(0, 0, 1, 1);
			context.fillStyle = css;
			context.fillRect(0, 0, 1, 1);
			const [r = 0, g = 0, b = 0, a = 0] = context.getImageData(0, 0, 1, 1).data;
			return [r, g, b, a];
		}
		function luminance([r, g, b]: number[]): number {
			const channel = (value: number) => {
				const c = value / 255;
				return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
			};
			return (
				0.2126 * channel(r ?? 0) + 0.7152 * channel(g ?? 0) + 0.0722 * channel(b ?? 0)
			);
		}
		const fg = rgba(getComputedStyle(element).color);
		let node: Element | null = element;
		let bg = rgba("transparent");
		while (node) {
			bg = rgba(getComputedStyle(node).backgroundColor);
			if (bg[3] === 255) break;
			node = node.parentElement;
		}
		const [light, dark] = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
		return ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05);
	});
}

for (const colorScheme of ["dark", "light"] as const) {
	test.describe(`Files pane Git marks (${colorScheme})`, () => {
		test.beforeEach(async ({ page }) => {
			await page.emulateMedia({ colorScheme });
		});

		test("each changed file wears its letter, with the same words on hover and for a screen reader", async ({
			page,
		}) => {
			await openProject(page, `Marks ${colorScheme}`);

			const readme = mark(page, "README.md", ".pk-git-letter");
			await expect(readme).toHaveText("M");
			await expect(readme).toHaveAttribute("title", "Modified since the last commit");
			await expect(row(page, "README.md")).toContainText(
				", Modified since the last commit",
			);

			// Untracked is U, not Git's "?", and is marked once: the U and a
			// muted name, no italic.
			const notes = mark(page, "notes.txt", ".pk-git-letter");
			await expect(notes).toHaveText("U");
			await expect(notes).toHaveAttribute("title", "New file, not yet tracked by Git");
			const name = mark(page, "notes.txt", ".pk-tree-name");
			await expect(name).toHaveCSS("font-style", "normal");
			const muted = await page.evaluate(() => {
				const probe = document.createElement("span");
				probe.style.color = "var(--ink-muted)";
				document.body.append(probe);
				const color = getComputedStyle(probe).color;
				probe.remove();
				return color;
			});
			await expect(name).toHaveCSS("color", muted);
			await expect(name).toHaveCSS("opacity", "1");

			// A tracked file has no mark at all.
			await expect(mark(page, "index.html", ".pk-git-letter")).toHaveCount(0);
		});

		test("a folder's mark says the most important change inside it", async ({
			page,
		}) => {
			await openProject(page, `Folders ${colorScheme}`);

			const expected = [
				// Only new files: green and "new", never the modified amber.
				[".portikus", "untracked", "Contains new files"],
				["app", "modified", "Contains modified files"],
				["old", "deleted", "Contains deleted files"],
				["merge", "conflict", "Contains a conflict"],
			] as const;
			for (const [path, kind, words] of expected) {
				const dot = mark(page, path, ".pk-git-dot");
				await expect(dot).toHaveAttribute("data-kind", kind);
				await expect(dot).toHaveAttribute("title", words);
				await expect(row(page, path)).toContainText(`, ${words}`);
			}
			// A conflict is told by its shape too, not by colour alone.
			await expect(mark(page, "merge", ".pk-git-dot svg")).toHaveAttribute(
				"data-icon",
				"alert",
			);

			await row(page, "merge").click();
			const clash = mark(page, "merge/clash.ts", ".pk-git-letter");
			await expect(clash).toHaveText("!");
			await expect(clash).toHaveAttribute(
				"title",
				"Conflict: Git could not merge this file",
			);
		});

		test("the letters meet 4.5:1 on plain, hovered and selected rows", async ({
			page,
		}) => {
			await openProject(page, `Contrast ${colorScheme}`);
			await row(page, "merge").click();
			await row(page, "app").click();

			const letters = [
				["README.md", ".pk-git-letter"],
				["notes.txt", ".pk-git-letter"],
				["app/extra.ts", ".pk-git-letter"],
				["merge/clash.ts", ".pk-git-letter"],
			] as const;
			for (const [path, selector] of letters) {
				const letter = mark(page, path, selector);
				expect(await contrast(letter), `${path} plain`).toBeGreaterThanOrEqual(4.5);
				await row(page, path).locator("> .pk-tree-row .pk-tree-name").hover();
				expect(await contrast(letter), `${path} hovered`).toBeGreaterThanOrEqual(4.5);
				// Ctrl-click selects the row without opening the file.
				await row(page, path)
					.locator("> .pk-tree-row .pk-tree-name")
					.click({ modifiers: ["Control"] });
				await expect(row(page, path)).toHaveAttribute("aria-selected", "true");
				expect(await contrast(letter), `${path} selected`).toBeGreaterThanOrEqual(4.5);
			}

			await page.mouse.move(0, 0);
			await expectNoViolations(page, '[data-testid="file-tree"]');
		});

		test("the Changes list uses the same letters", async ({ page }) => {
			await openProject(page, `Changes ${colorScheme}`);

			const letter = (path: string) =>
				page.getByTestId(`change-row-${path}`).locator(".pk-git-letter");
			await expect(letter("notes.txt")).toHaveText("U");
			await expect(letter("old/gone.ts")).toHaveText("D");
			await expect(letter("README.md")).toHaveText("M");
			await expect(letter("merge/clash.ts")).toHaveText("!");
			for (const path of ["notes.txt", "old/gone.ts", "README.md"]) {
				expect(await contrast(letter(path)), path).toBeGreaterThanOrEqual(4.5);
			}
			await expectNoViolations(page, '[data-testid="changes-section"]');
		});
	});
}

test("web pages and style sheets have different icons", async ({ page }) => {
	await openProject(page, "Icons");

	const icon = (path: string) => mark(page, path, ".pk-icon").first();
	await expect(icon("index.html")).toHaveAttribute("data-icon", "file-web");
	await expect(icon("styles.css")).toHaveAttribute("data-icon", "file-style");
	await expect(icon("README.md")).toHaveAttribute("data-icon", "file-markdown");
	await expect(icon("notes.txt")).toHaveAttribute("data-icon", "file");
	// The tint is a hint beside the glyph: the two families differ in colour too.
	const web = await icon("index.html").evaluate((el) => getComputedStyle(el).color);
	const style = await icon("styles.css").evaluate((el) => getComputedStyle(el).color);
	expect(web).not.toBe(style);
});
