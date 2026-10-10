import type * as Monaco from "monaco-editor";

/** The editor members `insertText` uses, so tests can pass a stand-in. */
export type InsertTarget = Pick<
	Monaco.editor.IStandaloneCodeEditor,
	"getSelection" | "getModel" | "executeEdits" | "pushUndoStop"
>;

/**
 * Type a dictated phrase at the cursor, replacing any selection, as one undo
 * step (SPEC.md §25.10). A phrase that follows a word gets one space in front,
 * unless it brings its own, so successive phrases do not run together. Focus is left alone: moving it
 * would blur the held mic button and stop listening.
 */
export function insertText(editor: InsertTarget, text: string): void {
	const selection = editor.getSelection();
	if (!selection || text === "") return;
	const before =
		selection.startColumn > 1
			? (editor
					.getModel()
					?.getLineContent(selection.startLineNumber)
					.charAt(selection.startColumn - 2) ?? "")
			: "";
	const typed = before !== "" && !/\s/.test(before + text[0]) ? ` ${text}` : text;
	// Undo stops on both sides keep this phrase apart from the typing around it.
	editor.pushUndoStop();
	editor.executeEdits("voice", [
		{ range: selection, text: typed, forceMoveMarkers: true },
	]);
	editor.pushUndoStop();
}
