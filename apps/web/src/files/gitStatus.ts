/**
 * Turning one `GitStatus` into what the screen shows (SPEC.md §12.1, §12.6,
 * §12.8): a letter and a style per path, a dot on the directories above a
 * change, the ignored test for the Show hidden view, and the compact branch
 * line of the status bar. Everything here is pure, so the rules can be
 * tested without a browser.
 */
import type { GitDiff, GitEntry, GitStatus } from "@portikus/contracts";
import { plural } from "../text.js";
import { parentOf } from "./paths.js";

/**
 * How a changed path is drawn. A conflict is deliberately its own kind: it
 * must never look like an ordinary modification (SPEC.md §12.8).
 */
export type GitDecorationKind =
	| "added"
	| "modified"
	| "deleted"
	| "renamed"
	| "untracked"
	| "conflict";

export interface GitDecoration {
	/** The single letter shown at the end of the row. */
	letter: string;
	kind: GitDecorationKind;
	/** The hover text: what changed, and where a rename came from. */
	title: string;
}

/** The letter for one porcelain code, ignoring conflicts and untracked files. */
function kindForCode(code: string): GitDecorationKind {
	switch (code) {
		case "A":
		case "C":
			return "added";
		case "D":
			return "deleted";
		case "R":
			return "renamed";
		default:
			return "modified";
	}
}

export const LETTER: Record<GitDecorationKind, string> = {
	added: "A",
	modified: "M",
	deleted: "D",
	renamed: "R",
	// U for untracked, as editors mark it, because Git's "?" means nothing to
	// a student. A conflict keeps "!" so it never reads as a letter of its own
	// kind (SPEC.md §12.8). The tree, the Changes list and a diff header all
	// read this table, so one path never wears two letters.
	untracked: "U",
	conflict: "!",
};

export const WORD: Record<GitDecorationKind, string> = {
	added: "Added",
	modified: "Modified",
	deleted: "Deleted",
	renamed: "Renamed",
	untracked: "Untracked",
	conflict: "Conflict",
};

/** The hover and screen-reader text for each kind, before any staged note. */
const TITLE: Record<GitDecorationKind, string> = {
	added: "Added since the last commit",
	modified: "Modified since the last commit",
	deleted: "Deleted since the last commit",
	renamed: "Renamed since the last commit",
	untracked: "New file, not yet tracked by Git",
	conflict: "Conflict: Git could not merge this file",
};

/** What a directory's dot says, for the most important change below it. */
export const DIR_TITLE: Record<GitDecorationKind, string> = {
	conflict: "Contains a conflict",
	deleted: "Contains deleted files",
	modified: "Contains modified files",
	renamed: "Contains renamed files",
	added: "Contains new files",
	untracked: "Contains new files",
};

/** Which change a directory's dot shows when it holds several: lower wins. */
const DIR_RANK: Record<GitDecorationKind, number> = {
	conflict: 0,
	deleted: 1,
	modified: 2,
	renamed: 3,
	added: 4,
	untracked: 5,
};

/**
 * What one entry looks like. The working-tree state wins when there is one,
 * because that is what the student last did; otherwise the staged state is
 * shown and the row is marked staged.
 */
export function decorate(entry: GitEntry): GitDecoration {
	const kind: GitDecorationKind = entry.unmerged
		? "conflict"
		: entry.x === "?" || entry.y === "?"
			? "untracked"
			: entry.y !== "."
				? kindForCode(entry.y)
				: kindForCode(entry.x);
	const staged = !entry.unmerged && entry.x !== "." && entry.x !== "?";
	const parts = [TITLE[kind]];
	if (staged) parts.push(entry.y === "." ? "(staged)" : "(staged and changed since)");
	if (entry.origPath) parts.push(`from ${entry.origPath}`);
	return { letter: LETTER[kind], kind, title: parts.join(" ") };
}

/** Everything the tree and the Changes list need about one project's Git state. */
export interface GitDecorations {
	repo: boolean;
	/** The decoration of each changed path, by its current path. */
	byPath: Map<string, GitDecoration>;
	/** Directories with a change underneath, and the most important such change. */
	changedDirs: Map<string, GitDecorationKind>;
	ignored: IgnoredPaths;
}

/**
 * The ignore list in the shape the tree asks it in: one lookup per row
 * instead of a walk of the whole list, because a repository can ignore a
 * great many paths and every row asks (SPEC.md §25.1).
 */
export interface IgnoredPaths {
	/** Paths ignored exactly, including a directory without its slash. */
	exact: Set<string>;
	/** Ignored directories, with the trailing slash, covering their subtrees. */
	prefixes: string[];
}

/** Turn Git's ignore list into the two collections `isIgnored` looks in. */
export function ignoredPaths(ignored: readonly string[]): IgnoredPaths {
	const exact = new Set<string>();
	const prefixes: string[] = [];
	for (const entry of ignored) {
		if (entry.endsWith("/")) {
			prefixes.push(entry);
			exact.add(entry.slice(0, -1));
		} else {
			exact.add(entry);
		}
	}
	return { exact, prefixes };
}

export const NO_DECORATIONS: GitDecorations = {
	repo: false,
	byPath: new Map(),
	changedDirs: new Map(),
	ignored: { exact: new Set(), prefixes: [] },
};

export function decorations(status: GitStatus | undefined): GitDecorations {
	if (!status?.repo) return NO_DECORATIONS;
	const byPath = new Map<string, GitDecoration>();
	const changedDirs = new Map<string, GitDecorationKind>();
	for (const entry of status.entries) {
		const decoration = decorate(entry);
		byPath.set(entry.path, decoration);
		for (let dir = parentOf(entry.path); dir !== ""; dir = parentOf(dir)) {
			const held = changedDirs.get(dir);
			if (held === undefined || DIR_RANK[decoration.kind] < DIR_RANK[held]) {
				changedDirs.set(dir, decoration.kind);
			}
		}
	}
	return { repo: true, byPath, changedDirs, ignored: ignoredPaths(status.ignored) };
}

/**
 * Whether Git ignores this path. An ignored entry that ends in `/` stands
 * for the whole subtree below it, so a prefix match is the right test.
 */
export function isIgnored(path: string, ignored: IgnoredPaths): boolean {
	if (ignored.exact.has(path)) return true;
	for (const prefix of ignored.prefixes) {
		if (path.startsWith(prefix)) return true;
	}
	return false;
}

/** One row of the Changes list (SPEC.md §12.6). */
export interface ChangeRow {
	path: string;
	/** The text of the row after the letter: a rename shows both paths. */
	label: string;
	decoration: GitDecoration;
}

/** The Changes list, in path order. */
export function changeRows(status: GitStatus | undefined): ChangeRow[] {
	if (!status?.repo) return [];
	return status.entries
		.map((entry) => {
			const decoration = decorate(entry);
			return {
				path: entry.path,
				label: entry.origPath ? `${entry.origPath} → ${entry.path}` : entry.path,
				decoration,
			};
		})
		.sort((left, right) => left.path.localeCompare(right.path));
}

/** The compact branch line of SPEC.md §12.8, as the status bar draws it. */
export interface GitBar {
	/** The whole line, already joined. */
	text: string;
	/** How many paths have an unresolved conflict; drawn conspicuously. */
	conflicts: number;
	repo: boolean;
}

/**
 * `main • 3 changes • 2 commits ahead`, and the other states the same line
 * has to carry: behind, no upstream, a detached HEAD, and conflicts.
 *
 * A detached HEAD is named by its short commit id (SPEC.md §12.8); an agent
 * that sends no id gets the bare words.
 */
export function gitBar(status: GitStatus | undefined): GitBar | null {
	if (!status) return null;
	if (!status.repo) {
		return { text: "not a git repository", conflicts: 0, repo: false };
	}
	const count = status.entries.length;
	const parts = [
		headPart(status),
		status.truncated ? `more than ${count} changes` : plural(count, "change"),
	];
	if (status.conflicts > 0) parts.push(plural(status.conflicts, "conflict"));
	parts.push(...upstreamParts(status));
	return { text: parts.join(" • "), conflicts: status.conflicts, repo: true };
}

/** The branch, or the commit a detached HEAD is at. */
function headPart(status: GitStatus): string {
	if (!status.detached) return status.branch ?? "no branch";
	return status.oid ? `detached HEAD at ${status.oid.slice(0, 7)}` : "detached HEAD";
}

/** How far the branch is from its upstream, or that it has none. */
function upstreamParts(status: GitStatus): string[] {
	if (status.upstream === null) return status.detached ? [] : ["no upstream"];
	const parts: string[] = [];
	if (status.ahead > 0) parts.push(`${plural(status.ahead, "commit")} ahead`);
	if (status.behind > 0) parts.push(`${plural(status.behind, "commit")} behind`);
	return parts;
}

/**
 * The decoration behind a diff's one-letter status, so a diff header is drawn
 * from the same table as the tree and the Changes list (SPEC.md §12.6). The
 * diff route reports "A" for anything that is not in HEAD, staged or not, so
 * it reads as added; the note under the header says which. Calling it
 * untracked would mislabel a file the student has already staged.
 */
export const DIFF_KIND: Record<GitDiff["status"], GitDecorationKind> = {
	M: "modified",
	A: "added",
	D: "deleted",
	R: "renamed",
	U: "conflict",
};
