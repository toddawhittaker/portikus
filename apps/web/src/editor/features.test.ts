import { beforeEach, expect, test, vi } from "vitest";

const imported: string[] = [];

/** Stand in for a Monaco contribution module and record that it was loaded. */
function stub(path: string) {
	vi.doMock(path, () => {
		imported.push(path);
		return {};
	});
}

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
];

beforeEach(() => {
	imported.length = 0;
	vi.resetModules();
	for (const path of PATHS) stub(path);
});

// The icon font lives in the codicon module alone. Without it the find
// widget's buttons draw as empty boxes (issue #219).
test("the editor features include the codicon icon font", async () => {
	const { loadEditorFeatures: load } = await import("./features");
	await load();
	expect(imported).toContain("monaco-editor/features/codicon/register.js");
});

test("the find widget's feature is loaded with the rest", async () => {
	const { loadEditorFeatures: load } = await import("./features");
	await load();
	expect(imported).toContain("monaco-editor/features/find/register.js");
});
