/**
 * The chat composer's editor (SPEC.md §10.8): Markdown typed into it is
 * shown formatted, with the markers hidden, and what it sends is the
 * Markdown text again. `**x**` is bold, `*x*` italic, a backtick pair a
 * code span, ``` a code block, and `- ` or `1. ` at the start of a line a
 * list. Enter sends, except inside a code block, where it adds a line and
 * Ctrl+Enter (Cmd+Enter on a Mac) sends. Shift+Enter always adds a line.
 * Pasted text arrives as plain text, never as formatted HTML; a paste of
 * more than LONG_PASTE_LINES lines is handed back to be attached as a file.
 */
import {
	Editor,
	type Editor as EditorType,
	Extension,
	markInputRule,
} from "@tiptap/core";
import Bold from "@tiptap/extension-bold";
import Code from "@tiptap/extension-code";
import CodeBlock from "@tiptap/extension-code-block";
import Document from "@tiptap/extension-document";
import Italic from "@tiptap/extension-italic";
import { BulletList, ListItem, OrderedList } from "@tiptap/extension-list";
import Paragraph from "@tiptap/extension-paragraph";
import Text from "@tiptap/extension-text";
import { Placeholder, UndoRedo } from "@tiptap/extensions";
import { Fragment, type Schema, Slice } from "@tiptap/pm/model";
import { toMarkdown } from "./composerMarkdown.js";

// Emphasis as CommonMark reads it: the markers hug the text, and the
// opening one follows a space or the line's start, so `2 * 3 * 4` and
// `snake_case` stay as typed.
const BOLD = /(?<=^|[\s([{"'])\*\*([^*\s](?:[^*]*[^*\s])?)\*\*$/;
const ITALIC = /(?<=^|[\s([{"'])\*([^*\s](?:[^*]*[^*\s])?)\*$/;
const FENCE = /^```([\w+#.-]*)$/;

/** A paste longer than this many lines, an error log say, is attached as a file instead. */
export const LONG_PASTE_LINES = 40;

/** Lines in pasted text; a final newline does not start another. */
export function lineCount(text: string): number {
	return text.replace(/\n$/, "").split("\n").length;
}

export interface ComposerEditorOptions {
	element: HTMLElement;
	/** Set on the editable element: its name, role, id and description. */
	attributes: Record<string, string>;
	placeholder: string;
	onSend: () => void;
	onFiles: (files: File[]) => void;
	/** Text pasted of more than LONG_PASTE_LINES lines, with its line count. */
	onLongPaste: (text: string, lines: number) => void;
	/** Sees each key first; returning true stops the editor handling it. */
	onKeyDown: (event: KeyboardEvent) => boolean;
	onKeyUp: (event: KeyboardEvent) => void;
	/** Called after each change of document or selection. */
	onChange: (editor: EditorType) => void;
}

/** The Markdown text the composer holds. */
export function composerText(editor: EditorType): string {
	return toMarkdown(editor.state.doc.content);
}

/** True while the cursor is in a code block, where Enter adds a line. */
export function inCodeBlock(editor: EditorType): boolean {
	return editor.state.selection.$from.parent.type.spec.code === true;
}

/** Dictated words go where the cursor is, set apart by a space. */
export function insertAtCursor(editor: EditorType, words: string): void {
	const { state } = editor;
	const { from, to, $from } = state.selection;
	const before = $from.parent.textBetween(0, $from.parentOffset, "\n");
	const lead = before !== "" && !/\s$/.test(before) ? " " : "";
	editor.view.dispatch(state.tr.insertText(lead + words, from, to).scrollIntoView());
}

/** Lines of plain text as paragraphs, open at both ends to join the line pasted into. */
function plainSlice(schema: Schema, text: string): Slice {
	const paragraph = schema.nodes.paragraph;
	if (!paragraph) return Slice.empty;
	const lines = text
		.split("\n")
		.map((line) => paragraph.create(null, line === "" ? null : schema.text(line)));
	return new Slice(Fragment.from(lines), 1, 1);
}

/** ```lang on a line of its own, with Enter at its end, opens a code block. */
function openFence(editor: EditorType): boolean {
	const { $from, empty } = editor.state.selection;
	if (!empty || $from.parent.type.name !== "paragraph") return false;
	if ($from.parentOffset !== $from.parent.content.size) return false;
	const match = FENCE.exec($from.parent.textContent);
	if (!match) return false;
	return editor
		.chain()
		.deleteRange({ from: $from.start(), to: $from.end() })
		.setCodeBlock(match[1] ? { language: match[1] } : undefined)
		.run();
}

export function createComposerEditor(options: ComposerEditorOptions): EditorType {
	const keys = Extension.create({
		name: "composerKeys",
		// Ahead of the list and code block keys, which would otherwise take Enter.
		priority: 1000,
		addKeyboardShortcuts() {
			const newLine = () =>
				this.editor.commands.first(({ commands }) => [
					() => commands.newlineInCode(),
					() => commands.splitListItem("listItem"),
					() => commands.liftListItem("listItem"),
					() => commands.createParagraphNear(),
					() => commands.liftEmptyBlock(),
					() => commands.splitBlock(),
				]);
			const send = () => {
				options.onSend();
				return true;
			};
			const enter = ({ editor }: { editor: EditorType }) => {
				if (openFence(editor)) return true;
				// The code block's own keys add the line, or leave after a blank pair.
				if (inCodeBlock(editor)) return false;
				return send();
			};
			return {
				Enter: enter,
				"Shift-Enter": ({ editor }) => openFence(editor) || newLine(),
				"Mod-Enter": send,
			};
		},
	});

	return new Editor({
		element: options.element,
		// The page's style policy and theme own every style; see composer.css.
		injectCSS: false,
		// Pasted text stays as typed; only typing turns markers into formatting.
		enablePasteRules: false,
		extensions: [
			Document,
			Paragraph,
			Text,
			Bold.extend({
				addInputRules() {
					return [markInputRule({ find: BOLD, type: this.type })];
				},
			}),
			Italic.extend({
				addInputRules() {
					return [markInputRule({ find: ITALIC, type: this.type })];
				},
			}),
			Code,
			CodeBlock,
			BulletList,
			OrderedList,
			// Tab leaves the box, as it does from any field (SPEC.md §25.8).
			ListItem.extend({ addKeyboardShortcuts: () => ({}) }),
			UndoRedo,
			Placeholder.configure({ placeholder: options.placeholder }),
			keys,
		],
		editorProps: {
			attributes: options.attributes,
			handleKeyDown: (_view, event) => options.onKeyDown(event),
			handleDOMEvents: {
				keyup: (_view, event) => {
					options.onKeyUp(event);
					return false;
				},
			},
			handlePaste: (view, event) => {
				const data = event.clipboardData;
				const files = Array.from(data?.files ?? []);
				if (files.length > 0) {
					options.onFiles(files);
					return true;
				}
				const text = (data?.getData("text/plain") ?? "").replace(/\r\n?/g, "\n");
				if (text === "") return true;
				const lines = lineCount(text);
				if (lines > LONG_PASTE_LINES) {
					options.onLongPaste(text, lines);
					return true;
				}
				const { state } = view;
				const tr = state.selection.$from.parent.type.spec.code
					? state.tr.insertText(text)
					: state.tr.replaceSelection(plainSlice(state.schema, text));
				view.dispatch(tr.scrollIntoView().setMeta("paste", true));
				return true;
			},
			// Files dropped on the box are the form's to attach.
			handleDrop: (_view, event) =>
				Array.from(event.dataTransfer?.types ?? []).includes("Files"),
			// Copying from the box gives the Markdown it would send.
			clipboardTextSerializer: (slice) => toMarkdown(slice.content),
		},
		onUpdate: ({ editor }) => options.onChange(editor),
		onSelectionUpdate: ({ editor }) => options.onChange(editor),
	});
}
