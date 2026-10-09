import type * as Monaco from "monaco-editor";

/** The editor members `insertText` uses, so tests can pass a stand-in. */
export type InsertTarget = Pick<
	Monaco.editor.IStandaloneCodeEditor,
	"getSelection" | "executeEdits" | "pushUndoStop" | "focus"
>;

/**
 * Type `text` at the cursor, replacing any selection, as one undo step, and
 * keep focus in the editor (SPEC.md §25.10: dictation into an open file).
 */
export function insertText(editor: InsertTarget, text: string): void {
	const selection = editor.getSelection();
	if (!selection || text === "") return;
	// Undo stops on both sides keep this phrase apart from the typing around it.
	editor.pushUndoStop();
	editor.executeEdits("voice", [{ range: selection, text, forceMoveMarkers: true }]);
	editor.pushUndoStop();
	editor.focus();
}
