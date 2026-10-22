import type { CodeHelpLanguage } from "@portikus/contracts";

interface LanguageRow {
	name: string;
	/** What runs it and where. */
	runs: string;
}

/** Each language an administrator can tick; a language added to the contract must be named here. */
export const SHIPPED_LANGUAGES: Record<CodeHelpLanguage, LanguageRow> = {
	python: { name: "Python", runs: "pyright and ruff, in each workspace" },
	typescript: {
		name: "TypeScript and JavaScript",
		runs: "TypeScript's language server, in each workspace",
	},
};

/**
 * Languages listed so administrators can see what is planned, but not yet
 * shipped or measured, so they cannot be ticked. Each gets an id in the
 * contract once its server is installed and measured.
 */
export const COMING_LATER_LANGUAGES: readonly LanguageRow[] = [
	{ name: "HTML, CSS and JSON", runs: "In the student's browser" },
	{ name: "Java", runs: "Eclipse JDT (jdtls), in each workspace" },
	{ name: "C and C++", runs: "clangd, in each workspace" },
	{ name: "SQL", runs: "Language server not chosen yet" },
];
