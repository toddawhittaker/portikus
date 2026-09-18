/** Monaco's language registrations are imported for their side effects only. */
declare module "monaco-editor/basic-languages/monaco.contribution.js";

/**
 * The JSON contribution also carries the handle for its diagnostics; the
 * editor API typings do not expose it, so only what is used is declared.
 */
declare module "monaco-editor/language/json/monaco.contribution.js" {
	export const jsonDefaults: {
		setDiagnosticsOptions(options: {
			validate: boolean;
			allowComments: boolean;
			schemas: unknown[];
			enableSchemaRequest: boolean;
		}): void;
	};
}

/** Monaco's editing features; imported for their side effects only. */
declare module "monaco-editor/features/find/register.js";
declare module "monaco-editor/editor/contrib/folding/browser/folding.js";
declare module "monaco-editor/editor/contrib/bracketMatching/browser/bracketMatching.js";
declare module "monaco-editor/editor/contrib/multicursor/browser/multicursor.js";
declare module "monaco-editor/editor/contrib/contextmenu/browser/contextmenu.js";
declare module "monaco-editor/editor/contrib/wordOperations/browser/wordOperations.js";
declare module "monaco-editor/editor/contrib/linesOperations/browser/linesOperations.js";
declare module "monaco-editor/editor/contrib/comment/browser/comment.js";
declare module "monaco-editor/editor/standalone/browser/quickAccess/standaloneCommandsQuickAccess.js";
declare module "monaco-editor/editor/standalone/browser/quickAccess/standaloneGotoLineQuickAccess.js";
