import { beforeEach, expect, test, vi } from "vitest";

const imported: string[] = [];

/** Stand in for a Monaco contribution module and record that it was loaded. */
function stub(path: string) {
	vi.doMock(path, () => {
		imported.push(path);
		return {};
	});
}

/** The widgets of the six code-help features (SPEC.md §13.6). */
const CODE_HELP_PATHS = [
	"monaco-editor/editor/contrib/suggest/browser/suggestController.js",
	"monaco-editor/editor/contrib/hover/browser/hoverContribution.js",
	"monaco-editor/editor/contrib/gotoSymbol/browser/goToCommands.js",
	"monaco-editor/editor/contrib/gotoSymbol/browser/link/goToDefinitionAtPosition.js",
	"monaco-editor/editor/contrib/rename/browser/rename.js",
	"monaco-editor/editor/contrib/format/browser/formatActions.js",
	"monaco-editor/editor/contrib/gotoError/browser/gotoError.js",
	"monaco-editor/editor/contrib/message/browser/messageController.js",
];

const PATHS = [
	"monaco-editor/features/codicon/register.js",
	"monaco-editor/features/find/register.js",
	"monaco-editor/editor/contrib/folding/browser/folding.js",
	"monaco-editor/editor/contrib/bracketMatching/browser/bracketMatching.js",
	"monaco-editor/editor/contrib/multicursor/browser/multicursor.js",
	"monaco-editor/editor/contrib/contextmenu/browser/contextmenu.js",
	"monaco-editor/editor/contrib/wordOperations/browser/wordOperations.js",
	"monaco-editor/editor/contrib/linesOperations/browser/linesOperations.js",
	"monaco-editor/editor/contrib/comment/browser/comment.js",
	"monaco-editor/editor/standalone/browser/quickAccess/standaloneCommandsQuickAccess.js",
	"monaco-editor/editor/standalone/browser/quickAccess/standaloneGotoLineQuickAccess.js",
	...CODE_HELP_PATHS,
];

beforeEach(() => {
	imported.length = 0;
	vi.resetModules();
	for (const path of PATHS) stub(path);
});

// The icon font lives in the codicon module alone. Without it the find
// widget's buttons draw as empty boxes.
test("the editor features include the codicon icon font", async () => {
	const { loadEditorFeatures: load } = await import("./features");
	await load();
	expect(imported).toContain("monaco-editor/features/codicon/register.js");
});

test("the code-help widgets are loaded: suggest, hover, definition, rename, format, problems", async () => {
	const { loadEditorFeatures: load } = await import("./features");
	await load();
	for (const path of CODE_HELP_PATHS) expect(imported).toContain(path);
});

test("the find widget's feature is loaded with the rest", async () => {
	const { loadEditorFeatures: load } = await import("./features");
	await load();
	expect(imported).toContain("monaco-editor/features/find/register.js");
});
