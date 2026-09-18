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
	"raw HTML": "# Title\n\n<script>alert(1)</script>\n",
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

test("raw HTML never becomes markup in the rich view", () => {
	const { container } = render(
		<RichMarkdownEditor
			text={"# Title\n\n<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n"}
			onChange={() => {}}
		/>,
	);
	// The rich view draws nothing at all for an HTML line; the text itself is
	// kept in the Markdown, which the round-trip tests above cover.
	const body = container.querySelector(".pk-rich-markdown-body");
	expect(body?.innerHTML).toBe(
		'<h1 dir="auto"><span data-lexical-text="true">Title</span></h1>',
	);
	expect(container.querySelector("script")).toBeNull();
	expect(container.querySelector("img")).toBeNull();
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
