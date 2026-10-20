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
		// The icon font the widgets draw their buttons with. Only
		// editor.main.js pulls this in, and we deliberately do not load that,
		// so without it the find widget's buttons render as empty boxes.
		import("monaco-editor/features/codicon/register.js"),
		import("monaco-editor/features/find/register.js"),
		import("monaco-editor/editor/contrib/folding/browser/folding.js"),
		import("monaco-editor/editor/contrib/bracketMatching/browser/bracketMatching.js"),
		import("monaco-editor/editor/contrib/multicursor/browser/multicursor.js"),
		import("monaco-editor/editor/contrib/contextmenu/browser/contextmenu.js"),
		import("monaco-editor/editor/contrib/wordOperations/browser/wordOperations.js"),
		import("monaco-editor/editor/contrib/linesOperations/browser/linesOperations.js"),
		import("monaco-editor/editor/contrib/comment/browser/comment.js"),
		// The key every editor's name offers for letting Tab leave (SPEC.md §25.8).
		import(
			"monaco-editor/editor/contrib/toggleTabFocusMode/browser/toggleTabFocusMode.js"
		),
		import(
			"monaco-editor/editor/standalone/browser/quickAccess/standaloneCommandsQuickAccess.js"
		),
		import(
			"monaco-editor/editor/standalone/browser/quickAccess/standaloneGotoLineQuickAccess.js"
		),
		// The widgets code help draws into (SPEC.md §13.6); the providers
		// behind them are in src/lsp.
		import("monaco-editor/editor/contrib/suggest/browser/suggestController.js"),
		import("monaco-editor/editor/contrib/hover/browser/hoverContribution.js"),
		import("monaco-editor/editor/contrib/gotoSymbol/browser/goToCommands.js"),
		import(
			"monaco-editor/editor/contrib/gotoSymbol/browser/link/goToDefinitionAtPosition.js"
		),
		import("monaco-editor/editor/contrib/rename/browser/rename.js"),
		import("monaco-editor/editor/contrib/format/browser/formatActions.js"),
		import("monaco-editor/editor/contrib/gotoError/browser/gotoError.js"),
		import("monaco-editor/editor/contrib/message/browser/messageController.js"),
	]);
}
