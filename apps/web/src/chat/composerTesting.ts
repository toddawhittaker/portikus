/**
 * Test helpers for the composer's editor. jsdom has no text input events,
 * so typing goes through ProseMirror's own text input hook, which is where
 * the editor's Markdown input rules listen.
 */

import { fireEvent } from "@testing-library/react";
import type { Editor } from "@tiptap/core";
import { act } from "react";
import { composerText } from "./composerEditor.js";

export function editorOf(box: HTMLElement): Editor {
	const editor = (box as HTMLElement & { editor?: Editor }).editor;
	if (!editor) throw new Error("not a composer editor");
	return editor;
}

/** The Markdown the box would send. */
export function boxText(box: HTMLElement): string {
	return composerText(editorOf(box));
}

/** Types at the cursor, a character at a time; "\n" is Shift+Enter. */
export function typeInto(box: HTMLElement, text: string): void {
	const { view } = editorOf(box);
	act(() => {
		for (const char of text) {
			if (char === "\n") {
				fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
				continue;
			}
			const { from, to } = view.state.selection;
			const insert = () => view.state.tr.insertText(char, from, to);
			const handled = view.someProp("handleTextInput", (handle) =>
				handle(view, from, to, char, insert),
			);
			if (!handled) view.dispatch(insert());
		}
	});
}

/** Replaces everything in the box with plain lines of text, as a paste would. */
export function setText(box: HTMLElement, text: string): void {
	const editor = editorOf(box);
	act(() => {
		editor.commands.clearContent(true);
		const { schema, tr } = editor.state;
		const lines = text
			.split("\n")
			.map((line) =>
				schema.nodes.paragraph?.create(null, line === "" ? null : schema.text(line)),
			);
		editor.view.dispatch(
			tr.replaceWith(
				0,
				editor.state.doc.content.size,
				lines.filter((n) => n !== undefined),
			),
		);
	});
}

/** Puts the cursor after `offset` characters of the first line. */
export function placeCursor(box: HTMLElement, offset: number): void {
	const editor = editorOf(box);
	act(() => {
		editor.commands.setTextSelection(1 + offset);
	});
}
