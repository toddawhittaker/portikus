/**
 * Format through the providers (SPEC.md §13.6): pressed while its server is
 * not ready, it says so at the cursor instead of doing nothing.
 */
import type * as Monaco from "monaco-editor";
import { expect, test, vi } from "vitest";
import type { CodeHelpManager } from "./manager.js";
import { registerProviders } from "./providers.js";
import { addManager, removeManager } from "./registry.js";

type FormatProvider = Monaco.languages.DocumentFormattingEditProvider;

function fakeMonaco(model: Monaco.editor.ITextModel, showMessage: () => void) {
	const formatters = new Map<string, FormatProvider>();
	const editor = {
		getModel: () => model,
		hasTextFocus: () => true,
		getPosition: () => ({ lineNumber: 1, column: 1 }),
		getContribution: () => ({ showMessage }),
	};
	const monaco = {
		Uri: { parse: (value: string) => value },
		editor: { getEditors: () => [editor] },
		languages: {
			registerCompletionItemProvider: vi.fn(),
			registerHoverProvider: vi.fn(),
			registerDefinitionProvider: vi.fn(),
			registerRenameProvider: vi.fn(),
			registerDocumentFormattingEditProvider: (
				language: string,
				provider: FormatProvider,
			) => formatters.set(language, provider),
		},
	} as unknown as typeof Monaco;
	return { monaco, formatters };
}

test("format while its server is not ready says so and edits nothing", async () => {
	const model = {
		uri: { scheme: "pk", path: "/p1/app.py" },
		getLanguageId: () => "python",
	} as unknown as Monaco.editor.ITextModel;
	const showMessage = vi.fn();
	const { monaco, formatters } = fakeMonaco(model, showMessage);
	const manager = { readyClient: () => null } as unknown as CodeHelpManager;
	addManager("p1", manager);
	registerProviders(monaco);

	const edits = await formatters
		.get("python")
		?.provideDocumentFormattingEdits(
			model,
			{ tabSize: 4, insertSpaces: true },
			{} as Monaco.CancellationToken,
		);

	expect(edits).toBeNull();
	expect(showMessage).toHaveBeenCalledWith("Format is not available right now.", {
		lineNumber: 1,
		column: 1,
	});
	removeManager("p1", manager);
});
