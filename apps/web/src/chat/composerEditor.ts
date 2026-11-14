/**
 * The chat composer's editor (SPEC.md §10.8): Markdown typed into it is
 * shown formatted, with the markers hidden, and what it sends is the
 * Markdown text again. `**x**` is bold, `*x*` italic, `***x***` both,
 * `~~x~~` struck through, a backtick pair a code span, and `[text](url)` or
 * a typed http(s) address a link. At the start of a line, ``` opens a code
 * block, `- ` or `1. ` a list, `[ ] ` or `[x] ` a task, `> ` a quote, `#` to
 * `###` a heading and `---` a separator line. In a list, Tab and Shift+Tab
 * indent and outdent an item; elsewhere Tab leaves the box. Enter sends, except inside a code block, where it adds a line and
 * Ctrl+Enter (Cmd+Enter on a Mac) sends. Shift+Enter always adds a line.
 * Pasted text arrives as plain text, never as formatted HTML; a paste of
 * more than LONG_PASTE_LINES lines is handed back to be attached as a file,
 * unless the same text is pasted again within REPASTE_MS, which puts it in
 * the box instead. `/` at the very start of the message, and `@` at a word's
 * start outside code, open the composer's menus (ComposerCommandMenu.tsx):
 * the editor reports what follows the character and hands the menu its keys.
 * Where the agent takes skills with a `$` (Codex), `$` at the very start opens
 * a skills-only list too. None opens while the message is a shell command
 * (inShellMode). The agent's name in the box's label and placeholder can
 * change after the editor is made (refreshComposer).
 */
import {
	Editor,
	type Editor as EditorType,
	Extension,
	InputRule,
	markInputRule,
} from "@tiptap/core";
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
import { Placeholder, UndoRedo } from "@tiptap/extensions";
import {
	Fragment,
	type Node as ProseMirrorNode,
	type Schema,
	Slice,
} from "@tiptap/pm/model";
import { type EditorState, Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import Suggestion from "@tiptap/suggestion";
import { isSafeLink } from "../markdown/sanitize.js";
import { toMarkdown } from "./composerMarkdown.js";
import { isShellCommand } from "./shellCommand.js";

// Emphasis as CommonMark reads it: the markers hug the text, and the
// opening one follows a space or the line's start, so `2 * 3 * 4` and
// `snake_case` stay as typed.
const BOLD = /(?<=^|[\s([{"'])\*\*([^*\s](?:[^*]*[^*\s])?)\*\*$/;
const ITALIC = /(?<=^|[\s([{"'])\*([^*\s](?:[^*]*[^*\s])?)\*$/;
const BOLD_ITALIC = /(?<=^|[\s([{"'])\*\*\*([^*\s](?:[^*]*[^*\s])?)\*\*\*$/;
const FENCE = /^```([\w+#.-]*)$/;
const LINK = /(?<=^|[\s([{"'])\[([^\]\n]+)\]\(([^()\s]+)\)$/;
const TASK = /^\s*\[( |x|X)?\]\s$/;

/** A paste longer than this many lines, an error log say, is attached as a file instead. */
export const LONG_PASTE_LINES = 40;

/** A second paste of the same long text this soon after the first goes in the box. */
const REPASTE_MS = 800;

/** Lines in pasted text; a final newline does not start another. */
export function lineCount(text: string): number {
	return text.replace(/\n$/, "").split("\n").length;
}

export interface ComposerEditorOptions {
	element: HTMLElement;
	/** Set on the editable element: its name, role, id and description; read again on refreshComposer. */
	attributes: () => Record<string, string>;
	/** Read again on refreshComposer. */
	placeholder: () => string;
	/** Whether `$` at the start opens the skills list; read as it is typed. */
	skills: () => boolean;
	onSend: () => void;
	onFiles: (files: File[]) => void;
	/** Text pasted of more than LONG_PASTE_LINES lines, with its line count. */
	onLongPaste: (text: string, lines: number) => void;
	/** The same long text pasted again within REPASTE_MS, now put in the box. */
	onRepaste: (lines: number) => void;
	/** Sees each key first; returning true stops the editor handling it. */
	onKeyDown: (event: KeyboardEvent) => boolean;
	onKeyUp: (event: KeyboardEvent) => void;
	/** Called after each change of document or selection. */
	onChange: (editor: EditorType) => void;
	/** A menu opened or its query changed (a menu), or it closed (null, with the kind that closed). */
	onMenu: (menu: ComposerMenu | null, closed?: ComposerMenuKind) => void;
	/** Sees each key while a menu is open, before the editor; true when the menu took it. */
	onMenuKey: (event: KeyboardEvent) => boolean;
}

/** `/` lists slash commands and skills; `$` skills alone; `@` the project's files. */
export type ComposerMenuKind = "command" | "skill" | "file";

/** An open menu: what was typed after its character, and where the trigger and query sit. */
export interface ComposerMenu {
	kind: ComposerMenuKind;
	query: string;
	from: number;
	to: number;
}

/** The menu's state the editor's own element carries for assistive technology. */
interface MenuAria {
	/** The shown list's id, or null while none is shown. */
	controls: string | null;
	/** The current option's id. */
	active: string | null;
}

const MENU_ARIA = new PluginKey<MenuAria>("composerMenuAria");

/** Say on the editor whether its menu is open and which option is current (SPEC.md §25.8). */
export function setMenuAria(editor: EditorType, aria: MenuAria): void {
	if (editor.isDestroyed) return;
	const now = MENU_ARIA.getState(editor.state);
	if (now?.controls === aria.controls && now.active === aria.active) return;
	editor.view.dispatch(editor.state.tr.setMeta(MENU_ARIA, aria));
}

/** Put a menu's choice in place of its trigger and query, with a space after it. */
export function chooseFromMenu(
	editor: EditorType,
	menu: ComposerMenu,
	text: string,
): void {
	if (editor.isDestroyed) return;
	const { state, view } = editor;
	view.dispatch(state.tr.insertText(`${text} `, menu.from, menu.to).scrollIntoView());
	view.focus();
}

/** Draw the label and placeholder again, after what they read has changed. */
export function refreshComposer(editor: EditorType): void {
	if (editor.isDestroyed) return;
	editor.view.dispatch(editor.state.tr);
}

/** Take out what a menu's trigger and query typed, leaving the rest. */
export function clearMenuText(editor: EditorType, menu: ComposerMenu): void {
	if (editor.isDestroyed) return;
	editor.view.dispatch(editor.state.tr.delete(menu.from, menu.to));
}

/** The Markdown text the composer holds. */
export function composerText(editor: EditorType): string {
	return toMarkdown(editor.state.doc.content);
}

/** True when there is nothing to send: no text, nor a rule or other block that writes some. */
export function isBlank(editor: EditorType): boolean {
	// Most boxes answer from their text alone, without serializing the document.
	if (editor.state.doc.textContent.trim() !== "") return false;
	return composerText(editor).trim() === "";
}

/** True while the cursor is in a code block, where Enter adds a line. */
export function inCodeBlock(editor: EditorType): boolean {
	return inCodeAt(editor.state);
}

function inCodeAt(state: EditorState): boolean {
	return state.selection.$from.parent.type.spec.code === true;
}

/**
 * True while the message would be sent as a shell command (SPEC.md §10.8):
 * the composer then marks itself, and the `/` and `@` menus stay shut.
 */
export function inShellMode(editor: EditorType): boolean {
	return shellAt(editor.state);
}

function shellAt(state: EditorState): boolean {
	// Most messages are cut short here, without serializing the whole document.
	if (!state.doc.textContent.trimStart().startsWith("!")) return false;
	return isShellCommand(toMarkdown(state.doc.content));
}

/** A space to set dictated words apart from the text before the cursor. */
function leadSpace(state: EditorState): string {
	const { $from } = state.selection;
	const before = $from.parent.textBetween(0, $from.parentOffset, "\n");
	return before !== "" && !/\s$/.test(before) ? " " : "";
}

/** Dictated words go where the cursor is, set apart by a space. */
export function insertAtCursor(editor: EditorType, words: string): void {
	const { state } = editor;
	const { from, to } = state.selection;
	const text = leadSpace(state) + words;
	editor.view.dispatch(state.tr.insertText(text, from, to).scrollIntoView());
}

const INTERIM = new PluginKey<string>("composerInterim");

/**
 * The recogniser's running guess, drawn greyed at the cursor. It is a
 * decoration, never part of the document, so it cannot be sent; it is
 * hidden from assistive technology, where the status region says
 * "Listening…" instead (SPEC.md §25.10).
 */
export function showInterim(editor: EditorType, words: string): void {
	if (editor.isDestroyed || INTERIM.getState(editor.state) === words) return;
	editor.view.dispatch(editor.state.tr.setMeta(INTERIM, words));
}

const interim = Extension.create({
	name: "composerInterim",
	addProseMirrorPlugins() {
		return [
			new Plugin<string>({
				key: INTERIM,
				state: {
					init: () => "",
					apply: (tr, now) => (tr.getMeta(INTERIM) as string | undefined) ?? now,
				},
				props: {
					decorations(state) {
						const words = INTERIM.getState(state) ?? "";
						if (words === "") return null;
						const text = leadSpace(state) + words;
						const widget = Decoration.widget(
							state.selection.head,
							() => {
								const span = document.createElement("span");
								span.className = "pk-composer-interim";
								span.setAttribute("aria-hidden", "true");
								span.dataset.testid = "chat-voice-interim";
								span.textContent = text;
								return span;
							},
							{ side: 1, key: text, ignoreSelection: true },
						);
						return DecorationSet.create(state.doc, [widget]);
					},
				},
			}),
		];
	},
});

/** Lines of plain text as paragraphs, open at both ends to join the line pasted into. */
function plainSlice(schema: Schema, text: string): Slice {
	const paragraph = schema.nodes.paragraph;
	if (!paragraph) return Slice.empty;
	const lines = text
		.split("\n")
		.map((line) => paragraph.create(null, line === "" ? null : schema.text(line)));
	return new Slice(Fragment.from(lines), 1, 1);
}

/** Text put in at the selection as a paste puts it: lines as paragraphs, or as written inside code. */
export function insertPlainText(view: EditorView, text: string): void {
	const { state } = view;
	const tr = state.selection.$from.parent.type.spec.code
		? state.tr.insertText(text)
		: state.tr.replaceSelection(plainSlice(state.schema, text));
	view.dispatch(tr.scrollIntoView().setMeta("paste", true));
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

/**
 * Rules the stock extensions lack: `***x***`, `[text](url)` with an http(s)
 * target only (the reply renderer's rule, SPEC.md §24.3), and `[ ] ` typed
 * at the start of a bullet item, which turns the item into a task.
 */
const markdownRules = Extension.create({
	name: "composerRules",
	priority: 1000,
	addInputRules() {
		const { schema } = this.editor;
		return [
			new InputRule({
				find: BOLD_ITALIC,
				handler: ({ state, range, match }) => {
					const { bold, italic } = schema.marks;
					if (!bold || !italic || !match[1]) return null;
					state.tr
						.replaceWith(
							range.from,
							range.to,
							schema.text(match[1], [bold.create(), italic.create()]),
						)
						.removeStoredMark(bold)
						.removeStoredMark(italic);
				},
			}),
			new InputRule({
				find: LINK,
				handler: ({ state, range, match }) => {
					const [, label, href] = match;
					const link = schema.marks.link;
					if (!link || !label || !href || !isSafeLink(href)) return null;
					state.tr
						.replaceWith(
							range.from,
							range.to,
							schema.text(label, [link.create({ href })]),
						)
						.removeStoredMark(link);
				},
			}),
			new InputRule({
				find: TASK,
				handler: ({ state, range, match, chain }) => {
					const { $from } = state.selection;
					const item = $from.node(-1).type.name;
					if ($from.index(-1) !== 0) return null;
					const checked = match[1] === "x" || match[1] === "X";
					// In a new task, the box typed again sets whether it is done.
					if (item === "taskItem") {
						chain().deleteRange(range).updateAttributes("taskItem", { checked }).run();
						return;
					}
					// Only a one-item list: toggleList would turn every bullet into a task.
					if (item !== "listItem" || $from.node(-2).childCount !== 1) return null;
					chain()
						.deleteRange(range)
						.toggleList("taskList", "taskItem")
						.updateAttributes("taskItem", { checked })
						.run();
				},
			}),
		];
	},
});

const ITEMS = ["listItem", "taskItem"] as const;

/** True when the cursor's list item sits inside another list item. */
function nestedItem(state: EditorState): boolean {
	const { $from } = state.selection;
	for (let depth = $from.depth; depth > 2; depth -= 1) {
		if (!(ITEMS as readonly string[]).includes($from.node(depth).type.name)) continue;
		return (ITEMS as readonly string[]).includes($from.node(depth - 2).type.name);
	}
	return false;
}

/** A task's checkbox is named by its own first line, not the sub-tasks under it. */
function taskLabel(node: ProseMirrorNode, checked: boolean): string {
	const text = node.firstChild?.textContent ?? "";
	return `${checked ? "Done" : "To do"}: ${text || "empty task"}`;
}

/** Each editor's way to forget its held long paste. */
const forgetters = new WeakMap<EditorType, () => void>();

/**
 * Forget the last long paste, so pasting it again is a new paste. Called on
 * send: the sent message points Claude at that paste's file, which a repeat
 * paste would otherwise delete.
 */
export function forgetLongPaste(editor: EditorType): void {
	forgetters.get(editor)?.();
}

export function createComposerEditor(options: ComposerEditorOptions): EditorType {
	/** The last long paste, held in memory only and only for REPASTE_MS (ADR 0012). */
	let longPaste: string | null = null;
	let forget: ReturnType<typeof setTimeout> | undefined;
	const remember = (text: string | null) => {
		clearTimeout(forget);
		longPaste = text;
		if (text !== null) forget = setTimeout(() => remember(null), REPASTE_MS);
	};

	const keys = Extension.create({
		name: "composerKeys",
		// Ahead of the list and code block keys, which would otherwise take Enter.
		priority: 1000,
		addKeyboardShortcuts() {
			const newLine = () =>
				this.editor.commands.first(({ commands }) => [
					() => commands.newlineInCode(),
					...ITEMS.map((item) => () => commands.splitListItem(item)),
					...ITEMS.map((item) => () => commands.liftListItem(item)),
					() => commands.createParagraphNear(),
					() => commands.liftEmptyBlock(),
					() => commands.splitBlock(),
				]);
			const indent = () =>
				this.editor.commands.first(({ commands }) =>
					ITEMS.map((item) => () => commands.sinkListItem(item)),
				);
			// Only a nested item; at the top Shift+Tab moves focus back (SPEC.md §25.8).
			const outdent = () =>
				nestedItem(this.editor.state) &&
				this.editor.commands.first(({ commands }) =>
					ITEMS.map((item) => () => commands.liftListItem(item)),
				);
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
				// Only in a list; anywhere else Tab leaves the box (SPEC.md §25.8).
				Tab: indent,
				"Shift-Tab": outdent,
			};
		},
	});

	const menus = Extension.create({
		name: "composerMenus",
		// Ahead of composerKeys, so Enter and Tab choose while a menu is open.
		priority: 1100,
		addProseMirrorPlugins() {
			const trigger = (kind: ComposerMenuKind, char: string, startOfLine: boolean) =>
				Suggestion({
					editor: this.editor,
					char,
					startOfLine,
					pluginKey: new PluginKey(`composerMenu-${kind}`),
					decorationClass: "pk-composer-trigger",
					// A command or skill only opens the message; a file anywhere outside code. A shell command has none.
					allow: ({ state, range }) =>
						!inCodeAt(state) &&
						(kind === "file" || range.from === 1) &&
						(kind !== "skill" || options.skills()) &&
						!shellAt(state),
					render: () => {
						const report = (props: {
							query: string;
							range: { from: number; to: number };
						}) => options.onMenu({ kind, query: props.query, ...props.range });
						return {
							onStart: report,
							onUpdate: report,
							onExit: () => options.onMenu(null, kind),
							onKeyDown: ({ event }) => options.onMenuKey(event),
						};
					},
				});
			return [
				trigger("command", "/", true),
				trigger("skill", "$", true),
				trigger("file", "@", false),
				new Plugin<MenuAria>({
					key: MENU_ARIA,
					state: {
						init: () => ({ controls: null, active: null }),
						apply: (tr, now) => (tr.getMeta(MENU_ARIA) as MenuAria | undefined) ?? now,
					},
					props: {
						attributes: (state) => {
							const aria = MENU_ARIA.getState(state);
							return {
								"aria-expanded": aria?.controls ? "true" : "false",
								...(aria?.controls ? { "aria-controls": aria.controls } : {}),
								...(aria?.controls && aria.active
									? { "aria-activedescendant": aria.active }
									: {}),
							};
						},
					},
				}),
			];
		},
	});

	const editor = new Editor({
		element: options.element,
		// The page's style policy and theme own every style; see composer.css.
		injectCSS: false,
		// Pasted text stays as typed; only typing turns markers into formatting.
		enablePasteRules: false,
		extensions: [
			Document,
			Paragraph,
			Text,
			// First, so a link's brackets sit outside any emphasis inside it.
			Link.configure({
				autolink: true,
				linkOnPaste: false,
				openOnClick: false,
				defaultProtocol: "https",
				isAllowedUri: (url) => isSafeLink(url),
				shouldAutoLink: (url) => isSafeLink(url),
			}),
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
			Strike,
			Code,
			CodeBlock,
			Blockquote,
			Heading.configure({ levels: [1, 2, 3] }),
			HorizontalRule,
			BulletList,
			OrderedList,
			// Tab and Enter in a list are the composerKeys' to handle.
			ListItem.extend({ addKeyboardShortcuts: () => ({}) }),
			TaskList,
			TaskItem.configure({
				nested: true,
				a11y: { checkboxLabel: taskLabel },
			}).extend({ addKeyboardShortcuts: () => ({}) }),
			markdownRules,
			UndoRedo,
			Placeholder.configure({ placeholder: () => options.placeholder() }),
			keys,
			menus,
			interim,
		],
		editorProps: {
			attributes: () => options.attributes(),
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
				const repaste = longPaste === text;
				remember(lines > LONG_PASTE_LINES && !repaste ? text : null);
				if (repaste) {
					options.onRepaste(lines);
				} else if (lines > LONG_PASTE_LINES) {
					options.onLongPaste(text, lines);
					return true;
				}
				const { state } = view;
				const link = state.schema.marks.link;
				const url = text.trim();
				if (link && isSafeLink(url) && !/\s/.test(url) && !inCodeAt(state)) {
					const linked = state.schema.text(url, [link.create({ href: url })]);
					view.dispatch(state.tr.replaceSelectionWith(linked, false).scrollIntoView());
					return true;
				}
				insertPlainText(view, text);
				return true;
			},
			// Files dropped on the box are the form's to attach.
			handleDrop: (_view, event) =>
				Array.from(event.dataTransfer?.types ?? []).includes("Files"),
			// Copying from the box gives the Markdown it would send.
			clipboardTextSerializer: (slice) => toMarkdown(slice.content),
		},
		onUpdate: ({ editor }) => options.onChange(editor),
		onDestroy: () => remember(null),
		onSelectionUpdate: ({ editor }) => options.onChange(editor),
	});
	forgetters.set(editor, () => remember(null));
	return editor;
}
