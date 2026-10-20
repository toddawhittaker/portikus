/**
 * LSP to Monaco and back. Both count columns in UTF-16 code units, so only
 * the 0-based (LSP) versus 1-based (Monaco) numbering differs (SPEC.md §13.6).
 */
import type * as Monaco from "monaco-editor";
import type {
	CompletionItem,
	Diagnostic,
	Location,
	LocationLink,
	Position,
	Range,
	TextEdit,
} from "vscode-languageserver-protocol";
import { toMarkdown } from "./content.js";
import type { Problem, ProblemSeverity } from "./store.js";

/** The URI scheme of the editor's project models (CodeEditor.tsx). */
const PROJECT_SCHEME = "pk";

/**
 * The model URI of a project file. Monaco models are global to the page, so
 * the project is part of the name (CodeEditor.tsx).
 */
export function projectModelUri(
	monaco: typeof Monaco,
	projectId: string,
	path: string,
): Monaco.Uri {
	return monaco.Uri.parse(`${PROJECT_SCHEME}:/${projectId}/${path}`);
}

/** The project and path of a `pk:/<projectId>/<path>` model, or null. */
export function projectModelPath(
	uri: Monaco.Uri,
): { projectId: string; path: string } | null {
	if (uri.scheme !== PROJECT_SCHEME) return null;
	const match = /^\/([^/]+)\/(.+)$/.exec(uri.path);
	if (!match) return null;
	return { projectId: match[1] as string, path: match[2] as string };
}

function encodePath(path: string): string {
	return path.split("/").map(encodeURIComponent).join("/");
}

/** The `file:` URI the server knows a project file by. */
export function serverUri(root: string, path: string): string {
	return `file://${encodePath(root)}/${encodePath(path)}`;
}

/**
 * The project-relative path of a server URI, or null when it is outside the
 * project. Servers differ in which characters they percent-encode, so the
 * decoded paths are compared.
 */
export function pathFromServerUri(root: string, uri: string): string | null {
	if (!uri.startsWith("file://")) return null;
	let decoded: string;
	try {
		decoded = decodeURIComponent(uri.slice("file://".length));
	} catch {
		return null;
	}
	if (!decoded.startsWith(`${root}/`)) return null;
	const path = decoded.slice(root.length + 1);
	if (path === "" || path.split("/").includes("..")) return null;
	return path;
}

export function toPosition(position: Monaco.IPosition): Position {
	return { line: position.lineNumber - 1, character: position.column - 1 };
}

export function toRange(range: Monaco.IRange): Range {
	return {
		start: { line: range.startLineNumber - 1, character: range.startColumn - 1 },
		end: { line: range.endLineNumber - 1, character: range.endColumn - 1 },
	};
}

export function fromRange(range: Range): Monaco.IRange {
	return {
		startLineNumber: range.start.line + 1,
		startColumn: range.start.character + 1,
		endLineNumber: range.end.line + 1,
		endColumn: range.end.character + 1,
	};
}

/** One Monaco content change as an LSP incremental change. */
export function toContentChange(change: Monaco.editor.IModelContentChange) {
	return {
		range: toRange(change.range),
		rangeLength: change.rangeLength,
		text: change.text,
	};
}

export function fromTextEdit(edit: TextEdit): Monaco.languages.TextEdit {
	return { range: fromRange(edit.range), text: edit.newText };
}

function severityOf(diagnostic: Diagnostic): ProblemSeverity {
	// LSP: 1 error, 2 warning, 3 information, 4 hint; missing means error.
	if (diagnostic.severity === 2) return "warning";
	if (diagnostic.severity === 3 || diagnostic.severity === 4) return "info";
	return "error";
}

/** LSP 3.18 lets a message be Markdown; markers and Problems show plain text. */
function messageOf(diagnostic: Diagnostic): string {
	const message = diagnostic.message;
	return typeof message === "string" ? message : message.value;
}

export function toProblem(path: string, diagnostic: Diagnostic): Problem {
	return {
		path,
		line: diagnostic.range.start.line + 1,
		column: diagnostic.range.start.character + 1,
		severity: severityOf(diagnostic),
		message: messageOf(diagnostic),
		source: diagnostic.source,
	};
}

export function toMarker(
	monaco: typeof Monaco,
	diagnostic: Diagnostic,
): Monaco.editor.IMarkerData {
	const severity = {
		error: monaco.MarkerSeverity.Error,
		warning: monaco.MarkerSeverity.Warning,
		info: monaco.MarkerSeverity.Info,
	}[severityOf(diagnostic)];
	const code = diagnostic.code;
	return {
		...fromRange(diagnostic.range),
		severity,
		message: messageOf(diagnostic),
		source: diagnostic.source,
		code: code === undefined ? undefined : String(code),
	};
}

/** LSP completion kinds are 1-based and in another order from Monaco's. */
const COMPLETION_KINDS = [
	"Text",
	"Method",
	"Function",
	"Constructor",
	"Field",
	"Variable",
	"Class",
	"Interface",
	"Module",
	"Property",
	"Unit",
	"Value",
	"Enum",
	"Keyword",
	"Snippet",
	"Color",
	"File",
	"Reference",
	"Folder",
	"EnumMember",
	"Constant",
	"Struct",
	"Event",
	"Operator",
	"TypeParameter",
] as const;

function completionKind(
	monaco: typeof Monaco,
	kind: number | undefined,
): Monaco.languages.CompletionItemKind {
	const name = kind === undefined ? undefined : COMPLETION_KINDS[kind - 1];
	return monaco.languages.CompletionItemKind[name ?? "Text"];
}

/**
 * One completion. Snippets were not asked for, so a server that sends one
 * anyway has it inserted as plain text.
 */
export function toCompletion(
	monaco: typeof Monaco,
	item: CompletionItem,
	wordRange: Monaco.IRange,
): Monaco.languages.CompletionItem {
	const edit = item.textEdit;
	let range: Monaco.languages.CompletionItem["range"] = wordRange;
	let insertText = item.insertText ?? item.label;
	if (edit && "range" in edit) {
		range = fromRange(edit.range);
		insertText = edit.newText;
	} else if (edit) {
		range = { insert: fromRange(edit.insert), replace: fromRange(edit.replace) };
		insertText = edit.newText;
	}
	const documentation = item.documentation
		? toMarkdown(item.documentation)[0]
		: undefined;
	return {
		label: item.label,
		kind: completionKind(monaco, item.kind),
		detail: item.detail,
		documentation,
		sortText: item.sortText,
		filterText: item.filterText,
		insertText,
		range,
		additionalTextEdits: item.additionalTextEdits?.map(fromTextEdit),
	};
}

/** A definition target: the URI the server named and the range to show. */
export interface Target {
	uri: string;
	range: Range;
}

export function definitionTargets(
	result: Location | Location[] | LocationLink[] | null,
): Target[] {
	if (result === null) return [];
	const list = Array.isArray(result) ? result : [result];
	return list.map((entry) =>
		"targetUri" in entry
			? { uri: entry.targetUri, range: entry.targetSelectionRange }
			: { uri: entry.uri, range: entry.range },
	);
}
