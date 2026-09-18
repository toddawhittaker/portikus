/**
 * Monaco's editing features (DESIGN.md §10). The editor API on its own has
 * none of them: each is a separate contribution, imported here by name rather
 * than through editor.main.js, which would also pull in every language
 * service the project deliberately leaves out (SPEC.md §13.2).
 *
 * They are gathered in one module so tests that stand in for Monaco have one
 * thing to replace.
 */
export async function loadEditorFeatures(): Promise<void> {
	await Promise.all([
		import("monaco-editor/features/find/register.js"),
		import("monaco-editor/editor/contrib/folding/browser/folding.js"),
		import("monaco-editor/editor/contrib/bracketMatching/browser/bracketMatching.js"),
		import("monaco-editor/editor/contrib/multicursor/browser/multicursor.js"),
		import("monaco-editor/editor/contrib/contextmenu/browser/contextmenu.js"),
		import("monaco-editor/editor/contrib/wordOperations/browser/wordOperations.js"),
		import("monaco-editor/editor/contrib/linesOperations/browser/linesOperations.js"),
		import("monaco-editor/editor/contrib/comment/browser/comment.js"),
		import(
			"monaco-editor/editor/standalone/browser/quickAccess/standaloneCommandsQuickAccess.js"
		),
		import(
			"monaco-editor/editor/standalone/browser/quickAccess/standaloneGotoLineQuickAccess.js"
		),
	]);
}
