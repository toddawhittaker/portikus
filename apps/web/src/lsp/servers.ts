/**
 * Which language server answers which feature for which Monaco language
 * (SPEC.md §13.6). Python Format goes to `ruff`; everything else of Python
 * goes to `python`, and all of TypeScript and JavaScript to `typescript`.
 */
import type { LanguageServerId } from "@portikus/contracts";

export type CodeHelpFeature =
	| "completion"
	| "hover"
	| "definition"
	| "rename"
	| "format"
	| "diagnostics";

/** The Monaco languages that get code help, and the server behind each. */
const PRIMARY: Record<string, LanguageServerId> = {
	python: "python",
	typescript: "typescript",
	javascript: "typescript",
};

export const CODE_HELP_LANGUAGES = Object.keys(PRIMARY);

/** The server for one feature of a language, or null when it has none. */
export function serverFor(
	language: string,
	feature: CodeHelpFeature,
): LanguageServerId | null {
	const primary = PRIMARY[language];
	if (primary === undefined) return null;
	if (primary === "python" && feature === "format") return "ruff";
	return primary;
}

/** Every server a document of this language is synced to. */
export function serversForLanguage(language: string): LanguageServerId[] {
	const primary = PRIMARY[language];
	if (primary === undefined) return [];
	return primary === "python" ? ["python", "ruff"] : [primary];
}

/**
 * The LSP language id. Monaco calls .tsx files "typescript", but the
 * TypeScript server parses JSX only under the React ids.
 */
export function lspLanguageId(language: string, path: string): string {
	if (path.endsWith(".tsx")) return "typescriptreact";
	if (path.endsWith(".jsx")) return "javascriptreact";
	return language;
}
