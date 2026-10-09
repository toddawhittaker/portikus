/**
 * The rendered Markdown view (SPEC.md §13.4). Student content is untrusted
 * (SPEC.md §24.2), so raw HTML must come out as text and an unsafe link
 * scheme must not survive.
 */
import { readFileSync } from "node:fs";
import { render, screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { MarkdownPreview } from "./MarkdownPreview.js";

/**
 * Stands in for Monaco's colorize. The ts fence gets escaped, classed output
 * as Monaco gives; the evil fence returns raw markup, as a Monaco bug might.
 */
vi.mock("./monaco.js", () => {
	const escapeHtml = (text: string) =>
		text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
	return {
		currentThemeName: () => "portikus-light",
		onThemeChange: () => () => {},
		colorizeFence: async (code: string, fence: string) => {
			if (fence === "ts" || fence === "html") {
				return code
					.split("\n")
					.map(
						(line) => `<span><span class="mtk6">${escapeHtml(line)}</span></span><br/>`,
					)
					.join("");
			}
			if (fence === "evil") {
				return '<img src="x" onerror="window.previewRan=1"><span class="mtk1" onclick="window.previewRan=1">a</span><br/>';
			}
			return null;
		},
	};
});

test("a GFM table renders as a table", () => {
	render(<MarkdownPreview text={"| Port | Use |\n| --- | --- |\n| 3000 | web |\n"} />);
	expect(screen.getByRole("table")).toBeTruthy();
	expect(screen.getByRole("columnheader", { name: "Port" })).toBeTruthy();
	expect(screen.getByRole("cell", { name: "3000" })).toBeTruthy();
});

test("a task list item carries a named, read-only checkbox and the task-list class", () => {
	const { container } = render(
		<MarkdownPreview text={"- [ ] Write tests\n- [x] Read spec\n"} />,
	);
	const boxes = screen.getAllByRole("checkbox", { name: "Task" });
	expect(boxes.map((box) => (box as HTMLInputElement).checked)).toEqual([false, true]);
	expect(boxes.every((box) => (box as HTMLInputElement).disabled)).toBe(true);
	// markdown.css hangs the box in the bullet's place through this class.
	expect(container.querySelectorAll("li.task-list-item")).toHaveLength(2);
});

test("raw HTML shows as text instead of being run", () => {
	const { container } = render(
		<MarkdownPreview text={"# Title\n\n<script>alert(1)</script>\n"} />,
	);
	expect(container.querySelector("script")).toBeNull();
	expect(container.textContent).toContain("<script>alert(1)</script>");
});

test("a javascript: link loses its href", () => {
	const { container } = render(
		<MarkdownPreview text={"[click](javascript:alert(1))\n"} />,
	);
	const link = container.querySelector("a");
	expect(link).not.toBeNull();
	expect(link?.getAttribute("href")).toBeFalsy();
});

test("an ordinary link opens in a new tab safely", () => {
	const { container } = render(
		<MarkdownPreview text={"[docs](https://example.invalid/docs)\n"} />,
	);
	const link = container.querySelector("a");
	expect(link?.getAttribute("href")).toBe("https://example.invalid/docs");
	expect(link?.getAttribute("target")).toBe("_blank");
	expect(link?.getAttribute("rel")).toBe("noopener noreferrer");
});

/** Stands in for the file route, so the test reads the project path it was given. */
const imageUrl = (projectPath: string) =>
	`/file?path=${encodeURIComponent(projectPath)}`;

test("a relative image resolves against the file's folder through the file route", () => {
	render(
		<MarkdownPreview
			text={"![Diagram](./diagram.png)\n\n![Up](../shared/logo.svg)\n"}
			path="docs/guide/README.md"
			imageUrl={imageUrl}
		/>,
	);
	expect(screen.getByRole("img", { name: "Diagram" }).getAttribute("src")).toBe(
		"/file?path=docs%2Fguide%2Fdiagram.png",
	);
	expect(screen.getByRole("img", { name: "Up" }).getAttribute("src")).toBe(
		"/file?path=docs%2Fshared%2Flogo.svg",
	);
});

test("an image outside the project keeps react-markdown's own rules", () => {
	render(
		<MarkdownPreview
			text={
				"![Web](https://example.invalid/a.png)\n\n![Bad](javascript:alert(1))\n\n![Out](../../a.png)\n"
			}
			path="docs/README.md"
			imageUrl={imageUrl}
		/>,
	);
	expect(screen.getByRole("img", { name: "Web" }).getAttribute("src")).toBe(
		"https://example.invalid/a.png",
	);
	expect(screen.getByRole("img", { name: "Bad" }).getAttribute("src")).toBeFalsy();
	// Above the project root is not the project, so it is left as written.
	expect(screen.getByRole("img", { name: "Out" }).getAttribute("src")).toBe(
		"../../a.png",
	);
});

test("reference-style links and images render, and their definitions draw nothing", () => {
	const { container } = render(
		<MarkdownPreview
			text={
				'See [the docs][docs] and [Spec][].\n\n![Diagram][pic]\n\n[docs]: https://example.invalid/docs\n[spec]: ./SPEC.md\n[pic]: ./diagram.png "A diagram"\n'
			}
			path="docs/README.md"
			imageUrl={imageUrl}
		/>,
	);
	expect(screen.getByRole("link", { name: "the docs" }).getAttribute("href")).toBe(
		"https://example.invalid/docs",
	);
	expect(screen.getByRole("link", { name: "Spec" }).getAttribute("href")).toBe(
		"./SPEC.md",
	);
	const image = screen.getByRole("img", { name: "Diagram" });
	expect(image.getAttribute("src")).toBe("/file?path=docs%2Fdiagram.png");
	expect(image.getAttribute("title")).toBe("A diagram");
	// A definition is not a line of the document.
	expect(container.textContent).not.toContain("[docs]:");
	expect(container.textContent).not.toContain("example.invalid");
	expect(container.querySelectorAll("p")).toHaveLength(2);
});

test("a reference-style link keeps the same scheme rules as an inline one", () => {
	const { container } = render(
		<MarkdownPreview text={"[click][bad]\n\n[bad]: javascript:alert(1)\n"} />,
	);
	expect(container.querySelector("a")?.getAttribute("href")).toBeFalsy();
});

test("a link is not rewritten to the file route, only an image", () => {
	const { container } = render(
		<MarkdownPreview
			text={"[notes](./notes.md)\n"}
			path="README.md"
			imageUrl={imageUrl}
		/>,
	);
	expect(container.querySelector("a")?.getAttribute("href")).toBe("./notes.md");
});

test("frontmatter is a collapsed block of raw text, not Markdown", () => {
	const { container } = render(
		<MarkdownPreview text={"---\n# title: Notes\n---\n\nBody text.\n"} />,
	);
	const details = container.querySelector("details.pk-frontmatter");
	expect(details).not.toBeNull();
	expect(details?.hasAttribute("open")).toBe(false);
	expect(details?.querySelector("pre")?.textContent).toBe("# title: Notes");
	expect(screen.getByText("Front matter")).toBeTruthy();
	// The `#` inside the block must not become a heading.
	expect(container.querySelector("h1")).toBeNull();
	expect(screen.getByText("Body text.")).toBeTruthy();
});

test("a fenced code block renders inside pre and code", () => {
	const { container } = render(<MarkdownPreview text={"```ts\nconst a = 1;\n```\n"} />);
	expect(container.querySelector("pre code")?.textContent).toContain("const a = 1;");
});

test("a fence that names a language is highlighted with the same text", async () => {
	const { container } = render(
		<MarkdownPreview text={"```ts\nconst a = 1;\nlet b;\n```\n"} />,
	);
	const code = container.querySelector("pre code");
	await waitFor(() => expect(code?.hasAttribute("data-colorized")).toBe(true));
	expect(code?.querySelectorAll("span.mtk6")).toHaveLength(2);
	expect(code?.textContent).toBe("const a = 1;\nlet b;\n");
});

test("markup inside a highlighted fence renders as text (SPEC.md 24.3)", async () => {
	const { container } = render(
		<MarkdownPreview text={"```html\n<img src=x onerror=alert(1)>\n```\n"} />,
	);
	const code = container.querySelector("pre code");
	await waitFor(() => expect(code?.hasAttribute("data-colorized")).toBe(true));
	expect(container.querySelector("img")).toBeNull();
	expect(code?.textContent).toBe("<img src=x onerror=alert(1)>\n");
});

test("raw markup from the highlighter itself never reaches the page", async () => {
	const { container } = render(<MarkdownPreview text={"```evil\nignored\n```\n"} />);
	const code = container.querySelector("pre code");
	await waitFor(() => expect(code?.hasAttribute("data-colorized")).toBe(true));
	expect(container.querySelector("img")).toBeNull();
	expect(code?.querySelector("span")?.hasAttribute("onclick")).toBe(false);
	expect((window as { previewRan?: number }).previewRan).toBeUndefined();
});

test("a fence in a language Monaco does not know stays plain", async () => {
	const { container } = render(<MarkdownPreview text={"```nope\nplain text\n```\n"} />);
	const code = container.querySelector("pre code");
	// Give the highlighter its turn before checking it left the block alone.
	await new Promise((resolve) => setTimeout(resolve, 20));
	expect(code?.hasAttribute("data-colorized")).toBe(false);
	expect(code?.textContent).toBe("plain text\n");
});

test("inline code is never highlighted", () => {
	const { container } = render(<MarkdownPreview text={"Run `npm test` now.\n"} />);
	expect(container.querySelector("p code")?.textContent).toBe("npm test");
	expect(container.querySelector("p code")?.hasAttribute("data-colorized")).toBe(false);
});

// Images with a workspace-relative path do not resolve here; serving them is
// not built yet.

test("a relative link stays in this tab and keeps its href", () => {
	const { container } = render(<MarkdownPreview text={"[notes](docs/notes.md)\n"} />);
	const link = container.querySelector("a");
	expect(link?.getAttribute("href")).toBe("docs/notes.md");
	expect(link?.getAttribute("target")).toBeNull();
	expect(link?.getAttribute("rel")).toBeNull();
});

test("a link carries no stray node attribute from react-markdown", () => {
	const { container } = render(
		<MarkdownPreview text={"[docs](https://example.invalid/docs)\n"} />,
	);
	expect(container.querySelector("a")?.hasAttribute("node")).toBe(false);
});

test("an empty frontmatter block shows no Front matter block", () => {
	const { container } = render(<MarkdownPreview text={"---\n---\n\nBody text.\n"} />);
	expect(container.querySelector("details.pk-frontmatter")).toBeNull();
	expect(screen.getByText("Body text.")).toBeTruthy();
});

test("bullet lists, nested lists and task lists render as real lists", () => {
	const { container } = render(
		<MarkdownPreview text={"- one\n- two\n  - nested\n- [ ] todo\n- [x] done\n"} />,
	);
	const list = container.querySelector("ul");
	expect(list).not.toBeNull();
	expect(list?.querySelectorAll(":scope > li").length).toBe(4);
	expect(list?.querySelector("li ul li")?.textContent).toBe("nested");
	const boxes = container.querySelectorAll('input[type="checkbox"]');
	expect(boxes.length).toBe(2);
	expect((boxes[1] as HTMLInputElement).checked).toBe(true);
});

test("an ordered list keeps its own starting number", () => {
	const { container } = render(<MarkdownPreview text={"5. five\n6. six\n"} />);
	const list = container.querySelector("ol");
	expect(list?.getAttribute("start")).toBe("5");
	expect(list?.querySelectorAll("li").length).toBe(2);
});

test("the stylesheet puts back the markers the page reset takes away", () => {
	// jsdom does not apply the imported stylesheet, so the rules the browser
	// needs are checked here and their effect in e2e/markdown.spec.ts.
	const css = readFileSync("apps/web/src/editor/markdown.css", "utf8");
	expect(css).toContain(".pk-markdown ul {\n\tlist-style-type: disc;");
	expect(css).toContain(".pk-markdown ol {\n\tlist-style-type: decimal;");
});

test("frontmatter after a byte order mark still does not render as Markdown", () => {
	// splitFrontmatter does not match the leading BOM, so remark-frontmatter is
	// what keeps the block out of the body here.
	const { container } = render(
		<MarkdownPreview text={"\uFEFF---\n# title: Notes\n---\n\nBody text.\n"} />,
	);
	expect(container.querySelector("h1")).toBeNull();
	expect(screen.getByText("Body text.")).toBeTruthy();
});

test("every rendered block carries the source line it came from", () => {
	const { container } = render(
		<MarkdownPreview text={"# Title\n\nA paragraph.\n\n- one\n- two\n"} />,
	);
	expect(container.querySelector("h1")?.getAttribute("data-line")).toBe("1");
	expect(container.querySelector("p")?.getAttribute("data-line")).toBe("3");
	const items = [...container.querySelectorAll("li")].map((item) =>
		item.getAttribute("data-line"),
	);
	expect(items).toEqual(["5", "6"]);
});

test("source lines count the frontmatter the preview cut off", () => {
	const { container } = render(
		<MarkdownPreview text={"---\ntitle: Notes\n---\n\n# Title\n\nBody.\n"} />,
	);
	// The heading is on line 5 of the file, not line 1 of the body.
	expect(container.querySelector("h1")?.getAttribute("data-line")).toBe("5");
	expect(container.querySelector("p")?.getAttribute("data-line")).toBe("7");
	// The frontmatter block itself stands for the top of the file.
	expect(screen.getByTestId("markdown-frontmatter").getAttribute("data-line")).toBe(
		"1",
	);
});
