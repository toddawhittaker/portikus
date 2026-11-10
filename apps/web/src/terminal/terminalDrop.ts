/**
 * What a drop on a terminal types (SPEC.md §9.6). Files dropped from the
 * desktop are saved under `.portikus/pastes/<stamp>/` and a file dragged from
 * the tree is already in the project; either way the terminal is sent the
 * absolute path, quoted for the shell, with a space after it and never a
 * newline, so nothing runs.
 */
import { nameError } from "../files/paths.js";
import { TREE_DRAG_TYPE } from "../files/useTreeDragAndDrop.js";
import { projectRoot } from "../projectRoot.js";

/** Characters a shell reads as plain text, so a path of only these needs no quotes. */
const SAFE_PATH = /^[A-Za-z0-9._/@%+=:,-]+$/;

// biome-ignore lint/suspicious/noControlCharactersInRegex: finding them is the point
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * `path` as one shell word, or null when it holds a control character: a
 * newline would run the line, and an escape could rewrite the screen.
 */
export function shellQuotePath(path: string): string | null {
	if (CONTROL.test(path)) return null;
	if (SAFE_PATH.test(path)) return path;
	return `'${path.replaceAll("'", "'\\''")}'`;
}

/** What a drag carries: desktop files, or rows from the file tree. */
export type DropKind = "files" | "tree";

export function dropKind(types: readonly string[]): DropKind | null {
	if (types.includes(TREE_DRAG_TYPE)) return "tree";
	if (types.includes("Files")) return "files";
	return null;
}

/** Why a desktop file's name cannot be dropped, or null when it can. */
export function dropNameError(name: string): string | null {
	const bad = nameError(name);
	if (bad) return bad;
	if (CONTROL.test(name)) {
		return "Rename it without special characters, then try again.";
	}
	return null;
}

/** How many folders a drop tries before giving up, for drops in one second. */
export const DROP_FOLDER_TRIES = 5;

/**
 * Where a dropped file can be saved, relative to the project root: the dated
 * folder first, then `-2`, `-3` variants for a name already taken there.
 */
export function dropPaths(now: Date, name: string): string[] {
	// One path segment: no colons, no milliseconds, no zone letter.
	const stamp = now.toISOString().slice(0, 19).replaceAll(":", "-");
	return Array.from({ length: DROP_FOLDER_TRIES }, (_, index) => {
		const suffix = index > 0 ? `-${index + 1}` : "";
		return `.portikus/pastes/${stamp}${suffix}/${name}`;
	});
}

/**
 * What the shell receives for dropped paths: the absolute paths, since the
 * shell may be in another directory, each quoted and followed by a space.
 * Null when any path holds a control character.
 */
export function droppedPathsInput(
	slug: string,
	paths: readonly string[],
): string | null {
	const words: string[] = [];
	for (const path of paths) {
		const word = shellQuotePath(`${projectRoot(slug)}/${path}`);
		if (word === null) return null;
		words.push(word);
	}
	return words.length === 0 ? null : `${words.join(" ")} `;
}
