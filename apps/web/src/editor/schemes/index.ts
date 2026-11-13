import type { EditorScheme as EditorSchemeId } from "@portikus/contracts";
import { CATPPUCCIN } from "./catppuccin.js";
import { GITHUB } from "./github.js";
import { HIGH_CONTRAST } from "./high-contrast.js";
import { INTELLIJ } from "./intellij.js";
import { PORTIKUS } from "./portikus.js";
import { SOLARIZED } from "./solarized.js";
import type { EditorScheme } from "./types.js";
import { VSCODE } from "./vscode.js";

/**
 * Every scheme, in the order Settings lists them. To add one, write its file
 * beside this one, add its id to EDITOR_SCHEMES in
 * packages/contracts/src/settings.ts, and list it here.
 */
export const EDITOR_SCHEME_LIST: readonly EditorScheme[] = [
	PORTIKUS,
	VSCODE,
	INTELLIJ,
	GITHUB,
	SOLARIZED,
	CATPPUCCIN,
	HIGH_CONTRAST,
];

/** The scheme with this id; the list has one for every id the contract allows. */
export function schemeById(id: EditorSchemeId): EditorScheme {
	return EDITOR_SCHEME_LIST.find((scheme) => scheme.id === id) ?? PORTIKUS;
}
