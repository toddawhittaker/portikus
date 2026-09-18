/**
 * Path arithmetic and name rules for the file tree (SPEC.md §11.1, §11.2,
 * §11.3). Everything here is pure so the rules can be tested on their own;
 * the agent checks the same things again on the server side.
 */
import { GENERATED_NAMES } from "@portikus/contracts";

const GENERATED = new Set<string>(GENERATED_NAMES);

/** The directory holding `path`, or "" for something at the project root. */
export function parentOf(path: string): string {
	const cut = path.lastIndexOf("/");
	return cut === -1 ? "" : path.slice(0, cut);
}

/** The last segment of a path. */
export function baseName(path: string): string {
	const cut = path.lastIndexOf("/");
	return cut === -1 ? path : path.slice(cut + 1);
}

/** Join a directory and a name; the project root is the empty directory. */
export function joinPath(dir: string, name: string): string {
	return dir === "" ? name : `${dir}/${name}`;
}

/**
 * Hidden by default: dotfiles and the generated or dependency directories of
 * SPEC.md §11.3. Hiding is only a view filter, so the terminal and the coding
 * agents still see everything.
 */
export function isHiddenName(name: string): boolean {
	return name.startsWith(".") || GENERATED.has(name);
}

/** Filter a listing for the Show hidden control. */
export function visibleEntries<T extends { name: string }>(
	entries: readonly T[],
	showHidden: boolean,
): T[] {
	return showHidden
		? [...entries]
		: entries.filter((entry) => !isHiddenName(entry.name));
}

/**
 * Why this name cannot be used, or null when it can. The message is the one
 * the student reads, so it says what to do rather than which rule broke.
 */
export function nameError(name: string): string | null {
	const trimmed = name.trim();
	if (trimmed === "") return "Enter a name.";
	if (trimmed === "." || trimmed === "..") return "That name is not allowed.";
	if (trimmed.includes("/") || trimmed.includes("\\")) {
		return "A name cannot contain a slash.";
	}
	if (trimmed.includes("\0")) return "That name is not allowed.";
	if (trimmed.length > 255) return "That name is too long.";
	return null;
}

/** True when `path` is inside `dir` at any depth. */
export function isDescendant(path: string, dir: string): boolean {
	if (dir === "") return path !== "";
	return path.startsWith(`${dir}/`);
}

/**
 * Whether dragging `from` into the directory `toDir` is a move worth making.
 * A directory cannot be dropped into itself or into anything it contains,
 * and dropping something back where it already is does nothing.
 */
export function canMoveInto(from: string, toDir: string): boolean {
	if (from === "") return false;
	if (from === toDir) return false;
	if (isDescendant(toDir, from)) return false;
	return parentOf(from) !== toDir;
}

/**
 * The move a finished drag asks for, or null when it asks for nothing. The
 * dragged row carries a `row:` id and the directory under it a `dir:` id.
 */
export function moveForDrop(
	activeId: string,
	overId: string | null,
): { from: string; to: string } | null {
	if (!activeId.startsWith("row:")) return null;
	if (overId === null || !overId.startsWith("dir:")) return null;
	const from = activeId.slice("row:".length);
	const dir = overId.slice("dir:".length);
	if (!canMoveInto(from, dir)) return null;
	return { from, to: joinPath(dir, baseName(from)) };
}

/** Drop `removed` and everything under it from a list of paths. */
export function prunePaths(paths: readonly string[], removed: string): string[] {
	return paths.filter((path) => path !== removed && !isDescendant(path, removed));
}

/** Rewrite `from` and everything under it to sit under `to` instead. */
export function rewritePaths(
	paths: readonly string[],
	from: string,
	to: string,
): string[] {
	return paths.map((path) => {
		if (path === from) return to;
		if (isDescendant(path, from)) return to + path.slice(from.length);
		return path;
	});
}

/**
 * The focused row after a render: keep it when it is still on screen, and
 * otherwise fall back to the first row, so the keyboard always has a place
 * to start from.
 */
export function reseedFocus(
	focused: string | null,
	rendered: readonly string[],
): string | null {
	if (focused !== null && rendered.includes(focused)) return focused;
	return rendered[0] ?? null;
}

/** The ids of the tabs showing `path` itself or anything inside it. */
export function tabIdsUnder(tabIds: readonly string[], path: string): string[] {
	return tabIds.filter((id) => {
		const cut = id.indexOf(":");
		if (cut === -1) return false;
		const kind = id.slice(0, cut);
		if (kind !== "file" && kind !== "diff") return false;
		const tabPath = id.slice(cut + 1);
		return tabPath === path || isDescendant(tabPath, path);
	});
}

/**
 * Control characters and the bidirectional marks let a name draw itself as
 * something it is not, so they never reach the screen (SPEC.md §24.6). The
 * bytes on disk are untouched.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: removing them is the point
const UNSAFE_DISPLAY = /[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/** A name as it is safe to draw. */
export function displayName(name: string): string {
	return name.replace(UNSAFE_DISPLAY, "");
}
