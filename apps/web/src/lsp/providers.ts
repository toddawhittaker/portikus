/**
 * The six features as Monaco providers (SPEC.md §13.6). Monaco's providers
 * are global per language, so they are registered once and find the
 * project's manager from the model's `pk:/<projectId>/...` URI. A server
 * that is not ready answers nothing, so editing never waits.
 */
import type * as Monaco from "monaco-editor";
import type {
	CompletionItem,
	CompletionList,
	Hover,
	Location,
	LocationLink,
	TextEdit,
	WorkspaceEdit,
} from "vscode-languageserver-protocol";
import type { LanguageClient } from "./client.js";
import { toMarkdown } from "./content.js";
import type { CodeHelpManager } from "./manager.js";
import { editorOf, showEditorMessage } from "./message.js";
import {
	definitionTargets,
	fromRange,
	fromTextEdit,
	projectModelPath,
	projectModelUri,
	toCompletion,
	toPosition,
} from "./protocol.js";
import { managerFor } from "./registry.js";
import { applyRename } from "./rename.js";
import { CODE_HELP_LANGUAGES, type CodeHelpFeature } from "./servers.js";

let registered = false;

function lookup(
	model: Monaco.editor.ITextModel,
	feature: CodeHelpFeature,
): { manager: CodeHelpManager; client: LanguageClient } | null {
	const where = projectModelPath(model.uri);
	if (where === null) return null;
	const manager = managerFor(where.projectId);
	const client = manager?.readyClient(model, feature) ?? null;
	return manager && client ? { manager, client } : null;
}

const position = (uri: string, at: Monaco.IPosition) => ({
	textDocument: { uri },
	position: toPosition(at),
});

/** The LSP item behind each suggestion, for completionItem/resolve. */
const origins = new WeakMap<
	Monaco.languages.CompletionItem,
	{ client: LanguageClient; model: Monaco.editor.ITextModel; item: CompletionItem }
>();

export function registerProviders(monaco: typeof Monaco): void {
	if (registered) return;
	registered = true;
	for (const language of CODE_HELP_LANGUAGES) {
		monaco.languages.registerCompletionItemProvider(language, {
			triggerCharacters: [".", '"', "'", "/", "@", "<"],
			async provideCompletionItems(model, at) {
				const found = lookup(model, "completion");
				if (!found?.client.ready?.completionProvider) return null;
				const result = await found.client.request<CompletionList | CompletionItem[]>(
					model,
					"textDocument/completion",
					(uri) => position(uri, at),
				);
				if (result === null) return null;
				const word = model.getWordUntilPosition(at);
				const wordRange = {
					startLineNumber: at.lineNumber,
					endLineNumber: at.lineNumber,
					startColumn: word.startColumn,
					endColumn: word.endColumn,
				};
				const items = Array.isArray(result) ? result : result.items;
				const suggestions = items.map((item) => {
					const suggestion = toCompletion(monaco, item, wordRange);
					origins.set(suggestion, { client: found.client, model, item });
					return suggestion;
				});
				return {
					suggestions,
					incomplete: !Array.isArray(result) && result.isIncomplete,
				};
			},
			async resolveCompletionItem(suggestion) {
				const origin = origins.get(suggestion);
				if (!origin?.client.ready?.completionProvider?.resolveProvider)
					return suggestion;
				const resolved = await origin.client.request<CompletionItem>(
					origin.model,
					"completionItem/resolve",
					() => origin.item,
				);
				if (resolved === null) return suggestion;
				return {
					...suggestion,
					detail: resolved.detail ?? suggestion.detail,
					documentation: resolved.documentation
						? toMarkdown(resolved.documentation)[0]
						: suggestion.documentation,
				};
			},
		});

		monaco.languages.registerHoverProvider(language, {
			async provideHover(model, at) {
				const found = lookup(model, "hover");
				if (!found?.client.ready?.hoverProvider) return null;
				const hover = await found.client.request<Hover>(
					model,
					"textDocument/hover",
					(uri) => position(uri, at),
				);
				if (hover === null) return null;
				return {
					contents: toMarkdown(hover.contents),
					range: hover.range ? fromRange(hover.range) : undefined,
				};
			},
		});

		monaco.languages.registerDefinitionProvider(language, {
			async provideDefinition(model, at) {
				const found = lookup(model, "definition");
				if (!found?.client.ready?.definitionProvider) return null;
				const result = await found.client.request<
					Location | Location[] | LocationLink[]
				>(model, "textDocument/definition", (uri) => position(uri, at));
				const { projectId } = found.manager.options;
				return definitionTargets(result).map((target) => {
					const path = found.client.pathOf(target.uri);
					return {
						// A target outside the project keeps its file: URI, and the
						// opener says it is not opened (opener.ts).
						uri:
							path === null
								? monaco.Uri.parse(target.uri)
								: projectModelUri(monaco, projectId, path),
						range: fromRange(target.range),
					};
				});
			},
		});

		monaco.languages.registerRenameProvider(language, {
			async provideRenameEdits(model, at, newName) {
				// The edits are applied here, not by Monaco, which can only edit
				// files already open; Monaco's own rejection notice is not shown in
				// a standalone editor, so the outcome is said at the cursor.
				const say = (text: string) => {
					const editor = editorOf(monaco, model);
					if (editor) showEditorMessage(editor, text);
				};
				const none = { edits: [] };
				const found = lookup(model, "rename");
				if (!found?.client.ready?.renameProvider) {
					say("Rename is not available right now.");
					return none;
				}
				const edit = await found.client.request<WorkspaceEdit>(
					model,
					"textDocument/rename",
					(uri) => ({ ...position(uri, at), newName }),
				);
				if (edit === null) {
					say("Nothing to rename here.");
					return none;
				}
				say(await applyRename(monaco, found.manager, found.client, edit));
				return none;
			},
		});

		monaco.languages.registerDocumentFormattingEditProvider(language, {
			async provideDocumentFormattingEdits(model, options) {
				const found = lookup(model, "format");
				if (!found?.client.ready?.documentFormattingProvider) return null;
				const edits = await found.client.request<TextEdit[]>(
					model,
					"textDocument/formatting",
					(uri) => ({
						textDocument: { uri },
						options: { tabSize: options.tabSize, insertSpaces: options.insertSpaces },
					}),
				);
				return edits?.map(fromTextEdit) ?? null;
			},
		});
	}
}
