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

/**
 * The key of a directory's "Show more" row. A NUL byte can never be in a
 * file name, so it never collides with a real row, and its parent is `dir`
 * so ArrowLeft returns to the folder like any child row does.
 */
export function showMorePath(dir: string): string {
	return joinPath(dir, "\u0000more");
}

/** "1 entry" or "5 entries". */
export function entryCount(count: number): string {
	return `${count.toLocaleString("en")} ${count === 1 ? "entry" : "entries"}`;
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
 * The move a drop of `from` on the directory `dir` asks for, or null when it
 * asks for nothing; null `dir` is a drop on no folder at all.
 */
export function moveForDrop(
	from: string,
	dir: string | null,
): { from: string; to: string } | null {
	if (dir === null || !canMoveInto(from, dir)) return null;
	return { from, to: joinPath(dir, baseName(from)) };
}

/**
 * Keep only the outermost paths: anything inside another path in the list is
 * already covered by it, so asking for it again would delete a file twice and
 * fail the second time.
 */
export function withoutNested(paths: readonly string[]): string[] {
	return paths.filter(
		(path) => !paths.some((other) => other !== path && isDescendant(path, other)),
	);
}

/** Drop `removed` and everything under it from a list of paths. */
export function prunePaths(paths: readonly string[], removed: string): string[] {
	return paths.filter((path) => path !== removed && !isDescendant(path, removed));
}

/**
 * Where `path` is after `from` moved to `to`: `from` itself or anything
 * inside it moves with it. Null when it did not move.
 */
export function movedPath(path: string, from: string, to: string): string | null {
	if (path === from) return to;
	if (isDescendant(path, from)) return to + path.slice(from.length);
	return null;
}

/** Rewrite `from` and everything under it to sit under `to` instead. */
export function rewritePaths(
	paths: readonly string[],
	from: string,
	to: string,
): string[] {
	return paths.map((path) => movedPath(path, from, to) ?? path);
}

/**
 * The focused row after a render. It stays when still on screen. When it is
 * gone, the keyboard user keeps their place (SPEC.md §25.8): the row now
 * drawn in its place when that is a sibling, else the row above it, else its
 * folder. `previous` is the order the rows were drawn in before the change.
 */
export function focusAfterRemoval(
	focused: string | null,
	previous: readonly string[],
	rendered: readonly string[],
): string | null {
	if (focused === null) return rendered[0] ?? null;
	const now = new Set(rendered);
	if (now.has(focused)) return focused;
	// A row inside a deleted folder goes with it; the folder is what was removed.
	let removed = focused;
	while (parentOf(removed) !== "" && !now.has(parentOf(removed))) {
		removed = parentOf(removed);
	}
	const at = previous.indexOf(removed);
	let above: string | undefined;
	for (let index = at - 1; index >= 0 && above === undefined; index -= 1) {
		if (now.has(previous[index] as string)) above = previous[index];
	}
	if (at !== -1) {
		const next =
			above === undefined ? rendered[0] : rendered[rendered.indexOf(above) + 1];
		if (next !== undefined && parentOf(next) === parentOf(removed)) return next;
		if (above !== undefined) return above;
	}
	const folder = parentOf(removed);
	return now.has(folder) ? folder : (rendered[0] ?? null);
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
