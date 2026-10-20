/**
 * Go to definition in another file (SPEC.md §13.6). A project file opens as
 * a tab at the line; a target outside the project is not opened, and a
 * short message says so.
 */
import type * as Monaco from "monaco-editor";
import { showEditorMessage } from "./message.js";
import { projectModelPath } from "./protocol.js";
import { managerFor } from "./registry.js";

export const OUTSIDE_PROJECT_MESSAGE =
	"That definition is outside the project, so it is not opened.";

let registered = false;

function lineOf(
	selection: Monaco.IRange | Monaco.IPosition | undefined,
): number | undefined {
	if (!selection) return undefined;
	return "startLineNumber" in selection
		? selection.startLineNumber
		: selection.lineNumber;
}

/** True when the request was handled, as Monaco's opener contract asks. */
export function openDefinition(
	source: Monaco.editor.ICodeEditor,
	resource: Monaco.Uri,
	selection: Monaco.IRange | Monaco.IPosition | undefined,
): boolean {
	const where = projectModelPath(resource);
	if (where === null) {
		if (resource.scheme !== "file") return false;
		showEditorMessage(source, OUTSIDE_PROJECT_MESSAGE);
		return true;
	}
	const manager = managerFor(where.projectId);
	if (!manager) return false;
	manager.options.openFile(where.path, lineOf(selection));
	return true;
}

export function registerOpener(monaco: typeof Monaco): void {
	if (registered) return;
	registered = true;
	monaco.editor.registerEditorOpener({ openCodeEditor: openDefinition });
}
