import { getSchema } from "@tiptap/core";
import Blockquote from "@tiptap/extension-blockquote";
import Bold from "@tiptap/extension-bold";
import Code from "@tiptap/extension-code";
import CodeBlock from "@tiptap/extension-code-block";
import Document from "@tiptap/extension-document";
import Heading from "@tiptap/extension-heading";
import HorizontalRule from "@tiptap/extension-horizontal-rule";
import Italic from "@tiptap/extension-italic";
import Link from "@tiptap/extension-link";
import {
	BulletList,
	ListItem,
	OrderedList,
	TaskItem,
	TaskList,
} from "@tiptap/extension-list";
import Paragraph from "@tiptap/extension-paragraph";
import Strike from "@tiptap/extension-strike";
import Text from "@tiptap/extension-text";
import type { Node } from "@tiptap/pm/model";
import { expect, test } from "vitest";
import { toMarkdown } from "./composerMarkdown.js";

const schema = getSchema([
	Document,
	Paragraph,
	Text,
	Link,
	Bold,
	Italic,
	Strike,
	Code,
	CodeBlock,
	Blockquote,
	Heading,
	HorizontalRule,
	BulletList,
	OrderedList,
	ListItem,
	TaskList,
	TaskItem.configure({ nested: true }),
]);

function doc(json: unknown[]): Node {
	return schema.nodeFromJSON({ type: "doc", content: json });
}

const text = (
	value: string,
	...marks: (string | { type: string; attrs: object })[]
) => ({
	type: "text",
	text: value,
	marks: marks.map((mark) => (typeof mark === "string" ? { type: mark } : mark)),
});
const link = (href: string) => ({ type: "link", attrs: { href } });
const p = (...content: unknown[]) => ({ type: "paragraph", content });
const item = (...content: unknown[]) => ({ type: "listItem", content });

test("overlapping bold and italic open and close once, hugging the text", () => {
	const node = doc([
		p(
			text("a "),
			text("bold ", "bold"),
			text("both", "bold", "italic"),
			text(" end", "bold"),
		),
	]);
	expect(toMarkdown(node.content)).toBe("a **bold *both* end**");
});

test("spaces at the edge of a mark move outside its markers", () => {
	expect(toMarkdown(doc([p(text("x"), text(" y ", "bold"), text("z"))]).content)).toBe(
		"x **y** z",
	);
});

test("a code span with backticks inside gets a longer fence", () => {
	expect(toMarkdown(doc([p(text("a`b", "code"))]).content)).toBe("``a`b``");
	expect(toMarkdown(doc([p(text("`x", "code"))]).content)).toBe("`` `x ``");
});

test("text is never escaped", () => {
	expect(toMarkdown(doc([p(text("1. *not* <b> \\ _x_"))]).content)).toBe(
		"1. *not* <b> \\ _x_",
	);
});

test("nested lists indent under their item, and the list stays tight", () => {
	const node = doc([
		{
			type: "bulletList",
			content: [
				item(p(text("one")), {
					type: "orderedList",
					attrs: { start: 1 },
					content: [item(p(text("a"))), item(p(text("b")))],
				}),
				item(p(text("two"))),
			],
		},
	]);
	expect(toMarkdown(node.content)).toBe("- one\n  1. a\n  2. b\n- two");
});

test("a code block keeps its language and its lines", () => {
	const node = doc([
		{ type: "codeBlock", attrs: { language: "ts" }, content: [text("a\n\nb")] },
	]);
	expect(toMarkdown(node.content)).toBe("```ts\na\n\nb\n```");
});

test("an empty document is empty text", () => {
	expect(toMarkdown(doc([p()]).content)).toBe("");
});

test("a link is [text](url), bare when its text is its address, and fenced when its address has brackets", () => {
	const node = doc([
		p(
			text("a "),
			text("docs", link("https://x.org/a")),
			text(" "),
			text("https://x.org", link("https://x.org")),
			text(" "),
			text("wiki", link("https://x.org/a_(b)")),
		),
	]);
	expect(toMarkdown(node.content)).toBe(
		"a [docs](https://x.org/a) https://x.org [wiki](<https://x.org/a_(b)>)",
	);
});

test("bold inside a link keeps the brackets outside", () => {
	const node = doc([
		p(text("big", link("https://x.org"), "bold"), text(" end", link("https://x.org"))),
	]);
	expect(toMarkdown(node.content)).toBe("[**big** end](https://x.org)");
});

test("strikethrough, and bold italic together", () => {
	const node = doc([
		p(text("gone", "strike"), text(" "), text("loud", "bold", "italic")),
	]);
	expect(toMarkdown(node.content)).toBe("~~gone~~ ***loud***");
});

test("headings, a separator line and a quote with a list inside", () => {
	const node = doc([
		{ type: "heading", attrs: { level: 2 }, content: [text("Plan")] },
		{ type: "horizontalRule" },
		{
			type: "blockquote",
			content: [
				p(text("said")),
				{ type: "bulletList", content: [item(p(text("a"))), item(p(text("b")))] },
			],
		},
	]);
	expect(toMarkdown(node.content)).toBe("## Plan\n\n---\n\n> said\n>\n> - a\n> - b");
});

test("task items carry their box, and nest like any list", () => {
	const task = (checked: boolean, ...content: unknown[]) => ({
		type: "taskItem",
		attrs: { checked },
		content,
	});
	const node = doc([
		{
			type: "taskList",
			content: [
				task(false, p(text("milk")), {
					type: "taskList",
					content: [task(true, p(text("oat")))],
				}),
				task(true, p(text("rent"))),
			],
		},
	]);
	expect(toMarkdown(node.content)).toBe("- [ ] milk\n  - [x] oat\n- [x] rent");
});
