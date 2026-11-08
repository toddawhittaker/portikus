import { getSchema } from "@tiptap/core";
import Bold from "@tiptap/extension-bold";
import Code from "@tiptap/extension-code";
import CodeBlock from "@tiptap/extension-code-block";
import Document from "@tiptap/extension-document";
import Italic from "@tiptap/extension-italic";
import { BulletList, ListItem, OrderedList } from "@tiptap/extension-list";
import Paragraph from "@tiptap/extension-paragraph";
import Text from "@tiptap/extension-text";
import type { Node } from "@tiptap/pm/model";
import { expect, test } from "vitest";
import { toMarkdown } from "./composerMarkdown.js";

const schema = getSchema([
	Document,
	Paragraph,
	Text,
	Bold,
	Italic,
	Code,
	CodeBlock,
	BulletList,
	OrderedList,
	ListItem,
]);

function doc(json: unknown[]): Node {
	return schema.nodeFromJSON({ type: "doc", content: json });
}

const text = (value: string, ...marks: string[]) => ({
	type: "text",
	text: value,
	marks: marks.map((type) => ({ type })),
});
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
