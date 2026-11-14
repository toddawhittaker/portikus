/**
 * The message box's history (SPEC.md §10.8): Up and Down on the first or
 * last line walk back and forward through what the student sent in this
 * chat, as a shell does, and Down past the newest gives back what they had
 * typed. The messages come from the chat's own conversation, so a reload or
 * a resumed chat has them; attachments are not recalled. Held in memory only
 * (SPEC.md §25.10, ADR 0012).
 */
import type { Editor, JSONContent } from "@tiptap/core";
import { type EditorState, TextSelection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { useRef } from "react";
import type { ChatItem, ChatStore } from "./chatStore.js";
import { composerText } from "./composerEditor.js";

/** Where the student is in the history, from the oldest message at 0. */
export interface Browsing {
	index: number;
	/** What the box held when they began, to give back past the newest. */
	draft: JSONContent;
	/** The box's text just after a message was put in it, to tell an edit. */
	shown: string;
}

/** What goes in the box: a sent message's text, or the draft as it was. */
export type Recall = { text: string } | { draft: JSONContent };

export interface Step {
	browsing: Browsing | null;
	/** Null when the box already shows the right thing. */
	show: Recall | null;
}

/**
 * The student's sent messages, oldest first: their own messages and `!`
 * commands in the conversation, then a message sent and not yet echoed.
 */
export function sentHistory(
	items: readonly ChatItem[],
	inFlight: string | null,
): string[] {
	const sent: string[] = [];
	for (const item of items) {
		if (item.kind === "message" && item.role === "user") sent.push(item.markdown);
		else if (item.kind === "shell") sent.push(`!${item.command}`);
	}
	if (inFlight !== null && sent[sent.length - 1] !== inFlight) sent.push(inFlight);
	return sent.filter((text) => text.trim() !== "");
}

/** Lines of text as paragraphs, written as typed: no formatting is read into them. */
export function plainDoc(text: string): JSONContent {
	return {
		type: "doc",
		content: text
			.split("\n")
			.map((line) =>
				line === ""
					? { type: "paragraph" }
					: { type: "paragraph", content: [{ type: "text", text: line }] },
			),
	};
}

/**
 * One press of Up or Down on the box's edge. Null leaves the key to the box:
 * nothing to go back to, or Down with no history being browsed.
 */
export function stepHistory(
	browsing: Browsing | null,
	direction: "up" | "down",
	history: readonly string[],
	current: { text: string; json: JSONContent },
): Step | null {
	// An edited message is the student's draft now; the next Up starts afresh.
	const walking = browsing && current.text === browsing.shown ? browsing : null;
	const newest = history.length - 1;
	if (direction === "up") {
		if (newest < 0) return null;
		if (!walking) {
			const text = history[newest] ?? "";
			return {
				browsing: { index: newest, draft: current.json, shown: text },
				show: { text },
			};
		}
		const index = Math.min(walking.index, newest);
		if (index === 0) return { browsing: { ...walking, index }, show: null };
		const text = history[index - 1] ?? "";
		return { browsing: { ...walking, index: index - 1, shown: text }, show: { text } };
	}
	if (!walking) return null;
	if (walking.index >= newest)
		return { browsing: null, show: { draft: walking.draft } };
	const index = walking.index + 1;
	const text = history[index] ?? "";
	return { browsing: { ...walking, index, shown: text }, show: { text } };
}

/** The start of the first, or the last, text block in the document. */
function edgeBlock(state: EditorState, which: "first" | "last"): number {
	let found = -1;
	state.doc.descendants((node, pos) => {
		if (!node.isTextblock) return true;
		if (which === "first" && found !== -1) return false;
		found = pos + 1;
		return false;
	});
	return found;
}

/**
 * Bring the editor's selection up to the caret the student sees. The editor
 * learns of a caret the browser moved (an arrow key) a moment later, so a
 * quick second press would find it a line behind.
 */
function syncCaret(view: EditorView): void {
	if (!view.hasFocus()) return;
	const page = view.dom.ownerDocument.getSelection();
	const { anchorNode, focusNode } = page ?? {};
	if (!page || !anchorNode || !focusNode) return;
	if (!view.dom.contains(anchorNode) || !view.dom.contains(focusNode)) return;
	try {
		const anchor = view.posAtDOM(anchorNode, page.anchorOffset);
		const head = view.posAtDOM(focusNode, page.focusOffset);
		const { selection, doc, tr } = view.state;
		if (selection.anchor === anchor && selection.head === head) return;
		view.dispatch(
			tr.setSelection(TextSelection.between(doc.resolve(anchor), doc.resolve(head))),
		);
	} catch {
		// The editor's own selection stands.
	}
}

/**
 * The cursor is on the first line of the box (`up`) or its last (`down`):
 * in its first or last text block, and on that block's first or last line as
 * drawn, so a long line that wraps is walked through before history is. A
 * selected range is left to the box.
 */
export function atEdge(view: EditorView, direction: "up" | "down"): boolean {
	syncCaret(view);
	const { selection } = view.state;
	if (!selection.empty) return false;
	const block = edgeBlock(view.state, direction === "up" ? "first" : "last");
	if (selection.$from.start() !== block) return false;
	try {
		return view.endOfTextblock(direction);
	} catch {
		// No layout to measure (a test document): the block's own edge is the line's.
		return true;
	}
}

/**
 * The box's history for one chat: what the student has sent, as the
 * conversation holds it, and where Up and Down have taken them in it.
 */
export function useComposerHistory(store: ChatStore) {
	/**
	 * Messages sent in this page, by text, to bring back with their formatting;
	 * one from before a reload comes back as plain text. Never stored (SPEC.md §25.10).
	 */
	const formatted = useRef(new Map<string, JSONContent>());
	/** Where the student is in the history, or null when not browsing. */
	const browsing = useRef<Browsing | null>(null);
	/** A message is being put in the box, which must not open the menu its first word asks for. */
	const recalling = useRef(false);

	/** Put what the history holds in the box, with the cursor at its end. */
	function show(box: Editor, what: Recall) {
		const content =
			"draft" in what
				? what.draft
				: (formatted.current.get(what.text) ?? plainDoc(what.text));
		recalling.current = true;
		try {
			box.chain().setContent(content, { emitUpdate: true }).focus("end").run();
		} finally {
			recalling.current = false;
		}
	}

	return {
		recalling,
		/** A message went out: the box starts afresh, and its formatting is kept to bring back. */
		sent(box: Editor, text: string) {
			browsing.current = null;
			if (text.trim() !== "") formatted.current.set(text, box.getJSON());
		},
		/**
		 * Up on the first line, or Down on the last, walks the history; false
		 * leaves the key to the box. `inFlight` is a message sent and not yet echoed.
		 */
		recall(box: Editor, direction: "up" | "down", inFlight: string | null): boolean {
			if (!atEdge(box.view, direction)) return false;
			const step = stepHistory(
				browsing.current,
				direction,
				sentHistory(store.getState().items, inFlight),
				{ text: composerText(box), json: box.getJSON() },
			);
			if (!step) return false;
			if (step.show) show(box, step.show);
			// What the box reads back is what an edit is told from.
			browsing.current = step.browsing && {
				...step.browsing,
				shown: composerText(box),
			};
			return true;
		},
	};
}
