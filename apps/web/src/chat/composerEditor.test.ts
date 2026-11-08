import { fireEvent } from "@testing-library/react";
import type { Editor } from "@tiptap/core";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
	composerText,
	createComposerEditor,
	inCodeBlock,
	insertAtCursor,
	LONG_PASTE_LINES,
	lineCount,
	showInterim,
} from "./composerEditor.js";
import { boxText, placeCursor, setText, typeInto } from "./composerTesting.js";

let editor: Editor;
let box: HTMLElement;
let onSend: ReturnType<typeof vi.fn<() => void>>;
let onFiles: ReturnType<typeof vi.fn<(files: File[]) => void>>;
let onLongPaste: ReturnType<typeof vi.fn<(text: string, lines: number) => void>>;

beforeEach(() => {
	onSend = vi.fn<() => void>();
	onFiles = vi.fn<(files: File[]) => void>();
	onLongPaste = vi.fn<(text: string, lines: number) => void>();
	const element = document.createElement("div");
	document.body.append(element);
	editor = createComposerEditor({
		element,
		attributes: {
			role: "textbox",
			"aria-multiline": "true",
			"aria-label": "Message Claude Code",
			"data-testid": "box",
		},
		placeholder: "Message Claude Code",
		onSend,
		onFiles,
		onLongPaste,
		onKeyDown: () => false,
		onKeyUp: () => {},
		onChange: () => {},
	});
	box = editor.view.dom;
});

afterEach(() => {
	editor.destroy();
	document.body.innerHTML = "";
});

function enter(init: Record<string, unknown> = {}) {
	return fireEvent.keyDown(box, { key: "Enter", ...init });
}

function paste(data: Record<string, string>, files: File[] = []) {
	fireEvent.paste(box, {
		clipboardData: {
			files,
			types: Object.keys(data),
			getData: (type: string) => data[type] ?? "",
		},
	});
}

test("the box is a labelled multi-line text box", () => {
	expect(box.getAttribute("role")).toBe("textbox");
	expect(box.getAttribute("aria-multiline")).toBe("true");
	expect(box.getAttribute("aria-label")).toBe("Message Claude Code");
	expect(box.getAttribute("contenteditable")).toBe("true");
});

test("typed Markdown markers become formatting and come back as the same text", () => {
	typeInto(box, "make **this** bold, *that* slanted and `x = 1` code");
	expect(box.querySelector("strong")?.textContent).toBe("this");
	expect(box.querySelector("em")?.textContent).toBe("that");
	expect(box.querySelector("code")?.textContent).toBe("x = 1");
	// The markers are hidden in the box.
	expect(box.textContent).toBe("make this bold, that slanted and x = 1 code");
	expect(boxText(box)).toBe("make **this** bold, *that* slanted and `x = 1` code");
});

test("stars and underscores that are not emphasis stay exactly as typed", () => {
	typeInto(box, "2 * 3 * 4 and snake_case_name and a*b*c");
	expect(box.querySelector("em")).toBeNull();
	expect(boxText(box)).toBe("2 * 3 * 4 and snake_case_name and a*b*c");
});

test("Enter sends, and Shift+Enter starts a new line", () => {
	typeInto(box, "first\nsecond");
	expect(onSend).not.toHaveBeenCalled();
	expect(boxText(box)).toBe("first\nsecond");
	enter();
	expect(onSend).toHaveBeenCalledTimes(1);
	// Two Shift+Enters leave a blank line, as in a textarea.
	setText(box, "");
	typeInto(box, "a\n\nb");
	expect(boxText(box)).toBe("a\n\nb");
});

test("Enter during composition is left to the input method", () => {
	fireEvent.compositionStart(box);
	enter({ isComposing: true, keyCode: 229 });
	expect(onSend).not.toHaveBeenCalled();
});

test("- and 1. start lists; Shift+Enter adds an item, and on an empty item leaves the list", () => {
	typeInto(box, "Steps:\n- one\ntwo\n\nthen\n1. first\nsecond");
	expect(box.querySelectorAll("ul > li")).toHaveLength(2);
	expect(box.querySelectorAll("ol > li")).toHaveLength(2);
	expect(boxText(box)).toBe("Steps:\n\n- one\n- two\n\nthen\n\n1. first\n2. second");
});

test("an ordered list keeps the number it started at", () => {
	typeInto(box, "3. third\nfourth");
	expect(boxText(box)).toBe("3. third\n4. fourth");
});

test("Tab outside a list, or on an item that cannot indent, is left so the keyboard can leave the box", () => {
	typeInto(box, "plain");
	// fireEvent returns false when the default was prevented.
	expect(fireEvent.keyDown(box, { key: "Tab" })).toBe(true);
	setText(box, "");
	typeInto(box, "- one");
	expect(fireEvent.keyDown(box, { key: "Tab" })).toBe(true);
	expect(boxText(box)).toBe("- one");
});

test("Tab and Shift+Tab indent and outdent list items, and nested lists come back as Markdown", () => {
	typeInto(box, "- one\ntwo");
	expect(fireEvent.keyDown(box, { key: "Tab" })).toBe(false);
	typeInto(box, "\nthree");
	expect(boxText(box)).toBe("- one\n  - two\n  - three");
	expect(box.querySelectorAll("ul ul > li")).toHaveLength(2);
	fireEvent.keyDown(box, { key: "Tab", shiftKey: true });
	expect(boxText(box)).toBe("- one\n  - two\n- three");
});

test("numbered items nest under their item, indented past its number", () => {
	typeInto(box, "1. one\ntwo");
	fireEvent.keyDown(box, { key: "Tab" });
	expect(boxText(box)).toBe("1. one\n   1. two");
});

test("[ ] and [x] after - start tasks, which come back as GFM task items", () => {
	typeInto(box, "- [ ] buy milk\n[x] pay rent");
	expect(box.querySelectorAll('ul[data-type="taskList"] > li')).toHaveLength(2);
	expect(boxText(box)).toBe("- [ ] buy milk\n- [x] pay rent");
	setText(box, "");
	typeInto(box, "[ ] alone");
	expect(boxText(box)).toBe("- [ ] alone");
});

test("> starts a quote, # to ### headings, and --- a separator line", () => {
	typeInto(box, "> quoted\nmore");
	expect(box.querySelector("blockquote")).toBeTruthy();
	expect(boxText(box)).toBe("> quoted\n> more");
	for (const [typed, tag] of [
		["# Big", "h1"],
		["## Mid", "h2"],
		["### Small", "h3"],
	] as const) {
		setText(box, "");
		typeInto(box, typed);
		expect(box.querySelector(tag)?.textContent).toBe(typed.replace(/^#+ /, ""));
		expect(boxText(box)).toBe(typed);
	}
	setText(box, "");
	typeInto(box, "#### Four");
	expect(box.querySelector("h4")).toBeNull();
	setText(box, "");
	typeInto(box, "above\n---");
	expect(box.querySelector("hr")).toBeTruthy();
	expect(boxText(box)).toBe("above\n\n---\n\n");
});

test("~~x~~ strikes through, and ***x*** is bold and italic", () => {
	typeInto(box, "a ~~gone~~ and ***loud*** end");
	expect(box.querySelector("s")?.textContent).toBe("gone");
	expect(box.querySelector("strong em, em strong")?.textContent).toBe("loud");
	expect(boxText(box)).toBe("a ~~gone~~ and ***loud*** end");
});

test("[text](url) and a typed address become links, http and https only", () => {
	typeInto(box, "see [the docs](https://example.com/a) and https://example.org ok");
	const links = Array.from(box.querySelectorAll("a"));
	expect(links.map((a) => a.getAttribute("href"))).toEqual([
		"https://example.com/a",
		"https://example.org",
	]);
	expect(boxText(box)).toBe(
		"see [the docs](https://example.com/a) and https://example.org ok",
	);
});

test("links to anything but http or https stay as typed text", () => {
	for (const target of [
		"javascript:alert(1)",
		"JavaScript:alert(1)",
		"data:text/html,x",
		"vbscript:x",
		"file:///etc/passwd",
		"mailto:a@b.c",
		"//example.com",
	]) {
		setText(box, "");
		typeInto(box, `[x](${target}) `);
		expect(box.querySelector("a")).toBeNull();
	}
	setText(box, "");
	paste({ "text/plain": "javascript:alert(1)" });
	expect(box.querySelector("a")).toBeNull();
});

test("a pasted address becomes a link", () => {
	paste({ "text/plain": "https://example.com/x?y=1" });
	expect(box.querySelector("a")?.getAttribute("href")).toBe(
		"https://example.com/x?y=1",
	);
	expect(boxText(box)).toBe("https://example.com/x?y=1");
});

test("``` and Enter open a code block; Enter adds lines there, and Ctrl+Enter sends", () => {
	typeInto(box, "Run this:\n```python");
	enter();
	expect(onSend).not.toHaveBeenCalled();
	expect(inCodeBlock(editor)).toBe(true);
	typeInto(box, "x = 1");
	enter();
	typeInto(box, "print(x)");
	expect(onSend).not.toHaveBeenCalled();
	expect(boxText(box)).toBe("Run this:\n\n```python\nx = 1\nprint(x)\n```");
	fireEvent.keyDown(box, { key: "Enter", ctrlKey: true });
	expect(onSend).toHaveBeenCalledTimes(1);
});

test("``` and a space open a code block too, and the fence outgrows backticks inside", () => {
	typeInto(box, "``` ");
	expect(inCodeBlock(editor)).toBe(true);
	typeInto(box, "a ``` b");
	expect(boxText(box)).toBe("````\na ``` b\n````");
});

test("two blank lines at the end of a code block leave it", () => {
	typeInto(box, "```");
	enter();
	typeInto(box, "code");
	enter();
	enter();
	enter();
	expect(inCodeBlock(editor)).toBe(false);
	typeInto(box, "after");
	expect(boxText(box)).toBe("```\ncode\n```\n\nafter");
});

test("pasted HTML arrives as its plain text, not as formatting or tags", () => {
	typeInto(box, "see ");
	paste({ "text/html": "<b>bold</b> <i>it</i>", "text/plain": "bold it" });
	expect(box.querySelector("strong")).toBeNull();
	expect(boxText(box)).toBe("see bold it");
});

test("pasted text keeps its blank lines and its Markdown exactly", () => {
	paste({ "text/plain": "one\r\n\r\n**two**\n- three\n" });
	expect(box.querySelector("strong")).toBeNull();
	expect(boxText(box)).toBe("one\n\n**two**\n- three\n");
});

test("text pasted into a code block stays in it", () => {
	typeInto(box, "```");
	enter();
	paste({ "text/plain": "a\n\nb" });
	expect(boxText(box)).toBe("```\na\n\nb\n```");
});

test("pasted files go to the attachments, not into the text", () => {
	const file = new File(["x"], "a.png", { type: "image/png" });
	paste({ Files: "" }, [file]);
	expect(onFiles).toHaveBeenCalledWith([file]);
	expect(boxText(box)).toBe("");
});

test("a paste of more than 40 lines is handed back to attach, and the box stays empty", () => {
	const log = Array.from({ length: LONG_PASTE_LINES + 1 }, (_, at) => `line ${at}`);
	paste({ "text/plain": `${log.join("\r\n")}\r\n` });
	expect(onLongPaste).toHaveBeenCalledWith(`${log.join("\n")}\n`, 41);
	expect(boxText(box)).toBe("");
});

test("a paste of exactly 40 lines goes into the box as text", () => {
	const lines = Array.from({ length: LONG_PASTE_LINES }, (_, at) => `l${at}`).join(
		"\n",
	);
	paste({ "text/plain": `${lines}\n` });
	expect(onLongPaste).not.toHaveBeenCalled();
	expect(boxText(box)).toBe(`${lines}\n`);
});

test("a final newline does not count as a line", () => {
	expect(lineCount("a")).toBe(1);
	expect(lineCount("a\nb\n")).toBe(2);
	expect(lineCount("a\n\nb")).toBe(3);
});

test("copying from the box gives the Markdown it would send", () => {
	typeInto(box, "a **b**");
	const { state } = editor;
	const text = editor.view.someProp("clipboardTextSerializer", (serialize) =>
		serialize(state.doc.slice(0, state.doc.content.size), editor.view),
	);
	expect(text).toBe("a **b**");
});

test("dictated words go in at the cursor, set apart by a space", () => {
	setText(box, "fix the bug");
	placeCursor(box, 3);
	insertAtCursor(editor, "now");
	expect(boxText(box)).toBe("fix now the bug");
	insertAtCursor(editor, "please");
	expect(composerText(editor)).toBe("fix now please the bug");
	setText(box, "");
	insertAtCursor(editor, "hello");
	expect(boxText(box)).toBe("hello");
});

test("Backspace straight after a rule undoes it, leaving the markers as typed", () => {
	typeInto(box, "**x**");
	expect(box.querySelector("strong")).toBeTruthy();
	fireEvent.keyDown(box, { key: "Backspace" });
	expect(box.querySelector("strong")).toBeNull();
	expect(boxText(box)).toBe("**x**");
});

test("interim dictation shows greyed at the cursor, hidden from assistive technology, never in the text", () => {
	setText(box, "fix the bug");
	placeCursor(box, 3);
	showInterim(editor, "no");
	const shown = box.querySelector(".pk-composer-interim");
	expect(shown?.textContent).toBe(" no");
	expect(shown?.getAttribute("aria-hidden")).toBe("true");
	expect(composerText(editor)).toBe("fix the bug");
	enter();
	expect(onSend).toHaveBeenCalledTimes(1);
	expect(composerText(editor)).toBe("fix the bug");
	showInterim(editor, "now");
	expect(box.querySelectorAll(".pk-composer-interim")).toHaveLength(1);
	insertAtCursor(editor, "now");
	showInterim(editor, "");
	expect(box.querySelector(".pk-composer-interim")).toBeNull();
	expect(composerText(editor)).toBe("fix now the bug");
});
