/**
 * The rendered Markdown view (SPEC.md §13.4). Student content is untrusted
 * (SPEC.md §24.2), so raw HTML must come out as text and an unsafe link
 * scheme must not survive.
 */
import { readFileSync } from "node:fs";
import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { MarkdownPreview } from "./MarkdownPreview.js";

test("a GFM table renders as a table", () => {
	render(<MarkdownPreview text={"| Port | Use |\n| --- | --- |\n| 3000 | web |\n"} />);
	expect(screen.getByRole("table")).toBeTruthy();
	expect(screen.getByRole("columnheader", { name: "Port" })).toBeTruthy();
	expect(screen.getByRole("cell", { name: "3000" })).toBeTruthy();
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

// Images with a workspace-relative path do not resolve here; serving them is
// out of scope for this task and is in the backlog.

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
