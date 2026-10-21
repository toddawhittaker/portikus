/**
 * A short message at the cursor, the way Monaco reports "No result"; it is
 * also announced to screen readers.
 */
import type * as Monaco from "monaco-editor";

interface MessageController {
	showMessage(message: string, position: Monaco.IPosition): void;
}

export function showEditorMessage(
	editor: Monaco.editor.ICodeEditor,
	message: string,
): void {
	const position = editor.getPosition();
	if (position === null) return;
	editor
		.getContribution<Monaco.editor.IEditorContribution & MessageController>(
			"editor.contrib.messageController",
		)
		?.showMessage(message, position);
}

/** The editor showing this model, the focused one first. */
export function editorOf(
	monaco: typeof Monaco,
	model: Monaco.editor.ITextModel,
): Monaco.editor.ICodeEditor | undefined {
	const editors = monaco.editor
		.getEditors()
		.filter((editor) => editor.getModel() === model);
	return editors.find((editor) => editor.hasTextFocus()) ?? editors[0];
}
