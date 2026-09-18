/**
 * The rich Markdown view (SPEC.md §13.4, issue #155). What matters is that
 * the Markdown a student wrote survives the trip through the editor, that
 * merely opening a file does not report an edit, and that student content
 * stays content and never becomes markup (SPEC.md §24.2).
 */
import { MDXEditor, type MDXEditorMethods } from "@mdxeditor/editor";
import { act, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { expect, test, vi } from "vitest";
import { endWithNewline } from "./markdownSync.js";
import { PLUGINS, RichMarkdownEditor, TO_MARKDOWN } from "./RichMarkdownEditor.js";

/** One sample of each construct a student's Markdown is likely to contain. */
const SAMPLES: Record<string, string> = {
	headings: "# Title\n\n## Section\n\nSome prose.\n",
	"bullet and numbered lists": "- one\n- two\n\n1. first\n2. second\n",
	"code fences": "```js\nconst a = 1;\n```\n",
	tables: "| Port | Use |\n| ---- | --- |\n| 3000 | web |\n",
	links: "Read [the docs](https://example.invalid/docs) first.\n",
	"block quotes": "> a quoted line\n",
	"front matter": "---\ntitle: Notes\n---\n\n# Title\n",
	"bold and italic": "Some **bold** and *italic* text.\n",
	"raw HTML": "# Title\n\n<script>alert(1)</script>\n\nAfter the tag.\n",
	"HTML comments": "# Title\n\n<!-- a note from an agent -->\n\nAfter the comment.\n",
	"inline HTML": "A line<br>and more.\n",
	"HTML blocks": "<details>\n<summary>More</summary>\n\nHidden.\n\n</details>\n",
	"HTML images": '<img src=x onerror="boom()">\n\nAfter the tag.\n',
	images: "# Title\n\n![build](https://img.example/badge.svg)\n\nAfter the badge.\n",
	"images with a refused address": "![x](javascript:boom)\n\nAfter the image.\n",
};

for (const [name, sample] of Object.entries(SAMPLES)) {
	test(`${name} come back out of the editor unchanged`, () => {
		// The same configuration the rich view uses, with a handle on it so the
		// test can ask what the editor would write back.
		const editor = createRef<MDXEditorMethods>();
		render(
			<MDXEditor
				ref={editor}
				markdown={sample}
				plugins={PLUGINS}
				toMarkdownOptions={TO_MARKDOWN}
				suppressHtmlProcessing
			/>,
		);
		expect(endWithNewline(editor.current?.getMarkdown() ?? "")).toBe(sample);
	});
}

test("opening a file reports no edit", async () => {
	vi.useFakeTimers();
	try {
		const changes: string[] = [];
		render(
			<RichMarkdownEditor
				text={SAMPLES.headings ?? ""}
				onChange={(value) => changes.push(value)}
			/>,
		);
		await act(async () => {
			vi.advanceTimersByTime(2000);
		});
		expect(changes).toEqual([]);
	} finally {
		vi.useRealTimers();
	}
});

test("an edit on the code side is loaded, and is not sent back as an edit", async () => {
	vi.useFakeTimers();
	try {
		const changes: string[] = [];
		const onChange = (value: string) => changes.push(value);
		const { rerender, container } = render(
			<RichMarkdownEditor text={"# One\n"} onChange={onChange} />,
		);
		expect(container.textContent).toContain("One");

		rerender(<RichMarkdownEditor text={"# One and two\n"} onChange={onChange} />);
		await act(async () => {
			vi.advanceTimersByTime(2000);
		});
		expect(container.textContent).toContain("One and two");
		// The loop guard: what came from the code side must not go back to it.
		expect(changes).toEqual([]);
	} finally {
		vi.useRealTimers();
	}
});

test("raw HTML is shown as its own source and never becomes markup", () => {
	const { container } = render(
		<RichMarkdownEditor
			text={
				"# Title\n\n<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\nThe end.\n"
			}
			onChange={() => {}}
		/>,
	);
	const body = container.querySelector(".pk-rich-markdown-body");
	// The source is displayed as text, so the student can see what is there.
	expect(body?.textContent).toContain("<script>alert(1)</script>");
	expect(body?.textContent).toContain("<img src=x onerror=alert(1)>");
	// Nothing after the HTML is lost. That was the bug: the importer threw on
	// the first HTML node and the rest of the file never appeared.
	expect(body?.textContent).toContain("The end.");
	// And none of it became markup in the control-plane origin (SPEC.md §24.2).
	expect(container.querySelector("script")).toBeNull();
	expect(container.querySelector("img")).toBeNull();
});

test("a README badge and an HTML comment leave the rest of the file readable", () => {
	let reported = 0;
	const { container } = render(
		<RichMarkdownEditor
			text={
				"# Project\n\n![build](https://img.example/badge.svg)\n\n<!-- written by an agent -->\n\nHow to run it.\n"
			}
			onChange={() => {}}
			onUnsupported={() => {
				reported += 1;
			}}
		/>,
	);
	const body = container.querySelector(".pk-rich-markdown-body");
	expect(body?.textContent).toContain("<!-- written by an agent -->");
	expect(body?.textContent).toContain("How to run it.");
	// No error was reported, so MDXEditor's export path is live and keystrokes
	// in this file reach the buffer.
	expect(reported).toBe(0);
});

test("an image whose address is not http(s) is shown as source, not loaded", () => {
	const { container } = render(
		<RichMarkdownEditor
			text={"![x](javascript:boom)\n\n![y](data:image/svg+xml;base64,AAAA)\n\nAfter.\n"}
			onChange={() => {}}
		/>,
	);
	const body = container.querySelector(".pk-rich-markdown-body");
	expect(body?.textContent).toContain("![x](javascript:boom)");
	expect(body?.textContent).toContain("![y](data:image/svg+xml;base64,AAAA)");
	expect(body?.textContent).toContain("After.");
	expect(container.querySelector("img")).toBeNull();
});

test("a construct nothing can read is reported instead of quietly losing the file", () => {
	let reported = 0;
	const { container } = render(
		<RichMarkdownEditor
			// A reference-style link: no plugin in this set claims it.
			text={"See [the docs][d].\n\n[d]: https://example.invalid/\n\nAfter.\n"}
			onChange={() => {}}
			onUnsupported={() => {
				reported += 1;
			}}
		/>,
	);
	expect(reported).toBeGreaterThan(0);
	// This is the state a student must not be left in, which is why FileLeaf
	// moves the tab to the code view when it hears this.
	expect(container.textContent).not.toContain("After.");
});

test("a javascript: link does not keep its href", () => {
	const { container } = render(
		<RichMarkdownEditor text={"[click](javascript:alert(1))\n"} onChange={() => {}} />,
	);
	const link = container.querySelector(".pk-rich-markdown-body a");
	expect(link).not.toBeNull();
	expect(link?.getAttribute("href") ?? "").not.toContain("javascript:");
});

test("the toolbar offers the basic formatting controls", () => {
	render(<RichMarkdownEditor text={"# Title\n"} onChange={() => {}} />);
	expect(screen.getByLabelText("Bold")).toBeTruthy();
	expect(screen.getByLabelText("Italic")).toBeTruthy();
	expect(screen.getByLabelText("Create link")).toBeTruthy();
});

test("a file with no final newline gets one back", () => {
	expect(endWithNewline("# Title")).toBe("# Title\n");
	expect(endWithNewline("# Title\n")).toBe("# Title\n");
	expect(endWithNewline("")).toBe("");
});
