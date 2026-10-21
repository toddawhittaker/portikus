/**
 * Rename across files (SPEC.md §13.6): inside the project only, at most 20
 * files, all or nothing. A file that is not open is opened as a tab, and
 * every changed file is saved through its tab's version-aware save
 * (SPEC.md §13.5), so a newer version on disk is never overwritten.
 */
import type * as Monaco from "monaco-editor";
import type { TextEdit, WorkspaceEdit } from "vscode-languageserver-protocol";
import type { LanguageClient } from "./client.js";
import { saveEditor, waitForEditor } from "./editors.js";
import type { CodeHelpManager } from "./manager.js";
import { fromTextEdit, projectModelUri } from "./protocol.js";

export const MAX_RENAME_FILES = 20;
const OPEN_TIMEOUT_MS = 10_000;

export interface FileEdits {
	path: string;
	edits: TextEdit[];
	/** The document version the server edited, when it said. */
	version: number | null;
}

/** The files a rename changes, or the reason it is refused. */
export function planRename(
	edit: WorkspaceEdit,
	pathOf: (uri: string) => string | null,
): { files: FileEdits[] } | { reason: string } {
	const byUri: Array<{ uri: string; edits: TextEdit[]; version: number | null }> = [];
	for (const change of edit.documentChanges ?? []) {
		if (!("textDocument" in change)) {
			return {
				reason: "Rename would create, move or delete files, so it was not done.",
			};
		}
		byUri.push({
			uri: change.textDocument.uri,
			edits: change.edits.filter((item): item is TextEdit => "range" in item),
			version: change.textDocument.version,
		});
	}
	if (!edit.documentChanges) {
		for (const [uri, edits] of Object.entries(edit.changes ?? {})) {
			byUri.push({ uri, edits, version: null });
		}
	}
	const files: FileEdits[] = [];
	for (const entry of byUri) {
		const path = pathOf(entry.uri);
		if (path === null) {
			return {
				reason: "Rename would change files outside the project, so it was not done.",
			};
		}
		const existing = files.find((file) => file.path === path);
		if (existing) existing.edits.push(...entry.edits);
		else files.push({ path, edits: [...entry.edits], version: entry.version });
	}
	if (files.length > MAX_RENAME_FILES) {
		return {
			reason: `Rename would change more than ${MAX_RENAME_FILES} files, so it was not done.`,
		};
	}
	if (files.length === 0) return { reason: "Nothing to rename here." };
	return { files };
}

/** Apply a server's rename; returns what to tell the student. */
export async function applyRename(
	monaco: typeof Monaco,
	manager: CodeHelpManager,
	client: LanguageClient,
	edit: WorkspaceEdit,
): Promise<string> {
	const plan = planRename(edit, (uri) => client.pathOf(uri));
	if ("reason" in plan) return plan.reason;
	const { projectId } = manager.options;
	const targets: Array<{ file: FileEdits; uri: Monaco.Uri }> = [];
	for (const file of plan.files) {
		const uri = projectModelUri(monaco, projectId, file.path);
		if (!monaco.editor.getModel(uri)) manager.options.openFile(file.path);
		targets.push({ file, uri });
	}
	const opened = await Promise.all(
		targets.map(({ uri }) => waitForEditor(uri.toString(), OPEN_TIMEOUT_MS)),
	);
	if (opened.includes(false))
		return "Not every file could be opened, so nothing was renamed.";
	const models = targets.map(({ file, uri }) => ({
		file,
		model: monaco.editor.getModel(uri),
	}));
	for (const { file, model } of models) {
		if (!model) return "Not every file could be opened, so nothing was renamed.";
		// A version from the server is the one it edited; a newer one means typing in between.
		if (file.version !== null && file.version !== model.getVersionId()) {
			return "A file changed while renaming, so nothing was renamed. Try again.";
		}
	}
	for (const { file, model } of models) {
		model?.pushEditOperations(
			[],
			file.edits.map((item) => ({ ...fromTextEdit(item), forceMoveMarkers: true })),
			() => null,
		);
	}
	for (const { uri } of targets) saveEditor(uri.toString());
	return models.length === 1
		? "Renamed in 1 file."
		: `Renamed in ${models.length} files.`;
}
