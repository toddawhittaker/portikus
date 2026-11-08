import { fireEvent } from "@testing-library/react";
import type { Editor } from "@tiptap/core";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
	composerText,
	createComposerEditor,
	inCodeBlock,
	insertAtCursor,
} from "./composerEditor.js";
import { boxText, placeCursor, setText, typeInto } from "./composerTesting.js";

let editor: Editor;
let box: HTMLElement;
let onSend: ReturnType<typeof vi.fn<() => void>>;
let onFiles: ReturnType<typeof vi.fn<(files: File[]) => void>>;

beforeEach(() => {
	onSend = vi.fn<() => void>();
	onFiles = vi.fn<(files: File[]) => void>();
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

test("Tab is not taken by a list item, so the keyboard can leave the box", () => {
	typeInto(box, "- one\ntwo");
	const tab = fireEvent.keyDown(box, { key: "Tab" });
	// fireEvent returns false when the default was prevented.
	expect(tab).toBe(true);
	expect(boxText(box)).toBe("- one\n- two");
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
