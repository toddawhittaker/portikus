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
