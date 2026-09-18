import type { GitEntry, GitStatus } from "@portikus/contracts";
import { expect, test } from "vitest";
import {
	changeRows,
	DIFF_KIND,
	decorate,
	decorations,
	gitBar,
	ignoredPaths,
	isIgnored,
	LETTER,
	WORD,
} from "./gitStatus.js";

function entry(partial: Partial<GitEntry> & { path: string }): GitEntry {
	return { x: ".", y: ".", unmerged: false, ...partial };
}

function status(partial: Partial<GitStatus> = {}): GitStatus {
	return {
		repo: true,
		branch: "main",
		detached: false,
		upstream: "origin/main",
		ahead: 0,
		behind: 0,
		conflicts: 0,
		entries: [],
		ignored: [],
		truncated: false,
		...partial,
	};
}

test("the working-tree state decides the letter and the kind", () => {
	expect(decorate(entry({ path: "a.ts", y: "M" }))).toMatchObject({
		letter: "M",
		kind: "modified",
	});
	expect(decorate(entry({ path: "a.ts", y: "D" }))).toMatchObject({
		letter: "D",
		kind: "deleted",
	});
	expect(decorate(entry({ path: "a.ts", x: "A", y: "." }))).toMatchObject({
		letter: "A",
		kind: "added",
	});
});

test("an untracked file is its own kind, not a modification", () => {
	const decoration = decorate(entry({ path: "new.ts", x: "?", y: "?" }));
	expect(decoration.kind).toBe("untracked");
	// Git's own mark, and never the "!" a conflict wears (SPEC.md §12.1).
	expect(decoration.letter).toBe("?");
	expect(decoration.title).toContain("Untracked");
});

test("a diff status is drawn from the same table as the tree", () => {
	expect(LETTER[DIFF_KIND.A]).toBe("?");
	expect(WORD[DIFF_KIND.A]).toBe("Untracked");
	expect(LETTER[DIFF_KIND.U]).toBe("!");
	expect(WORD[DIFF_KIND.U]).toBe("Conflict");
	expect(LETTER[DIFF_KIND.M]).toBe("M");
	expect(LETTER[DIFF_KIND.D]).toBe("D");
	expect(LETTER[DIFF_KIND.R]).toBe("R");
});

test("a conflict never looks like a modification", () => {
	const decoration = decorate(entry({ path: "a.ts", x: "U", y: "U", unmerged: true }));
	expect(decoration.kind).toBe("conflict");
	expect(decoration.letter).toBe("!");
	expect(decoration.title).toContain("Conflict");
});

test("a rename names the path it came from", () => {
	const decoration = decorate(
		entry({ path: "new.ts", x: "R", y: ".", origPath: "old.ts" }),
	);
	expect(decoration.kind).toBe("renamed");
	expect(decoration.title).toContain("from old.ts");
	expect(decoration.title).toContain("(staged)");
});

test("every directory above a change gets a dot", () => {
	const marks = decorations(
		status({ entries: [entry({ path: "src/deep/a.ts", y: "M" })] }),
	);
	expect([...marks.changedDirs].sort()).toEqual(["src", "src/deep"]);
	expect(marks.byPath.get("src/deep/a.ts")?.letter).toBe("M");
});

test("a project that is not a repository has no decorations", () => {
	expect(decorations(status({ repo: false })).byPath.size).toBe(0);
	expect(decorations(undefined).changedDirs.size).toBe(0);
});

test("an ignored entry ending in a slash covers its whole subtree", () => {
	const ignored = ignoredPaths(["node_modules/", "notes.txt"]);
	expect(isIgnored("node_modules", ignored)).toBe(true);
	expect(isIgnored("node_modules/pkg/index.js", ignored)).toBe(true);
	expect(isIgnored("notes.txt", ignored)).toBe(true);
	expect(isIgnored("node_modules-other", ignored)).toBe(false);
	expect(isIgnored("src/notes.txt", ignored)).toBe(false);
});

test("the Changes list is sorted by path and shows both ends of a rename", () => {
	const rows = changeRows(
		status({
			entries: [
				entry({ path: "src/b.ts", y: "M" }),
				entry({ path: "a.ts", x: "R", origPath: "old.ts" }),
			],
		}),
	);
	expect(rows.map((row) => row.label)).toEqual(["old.ts → a.ts", "src/b.ts"]);
});

test("the compact status line says branch, changes and commits ahead", () => {
	expect(
		gitBar(
			status({
				ahead: 2,
				entries: [
					entry({ path: "a", y: "M" }),
					entry({ path: "b", y: "M" }),
					entry({ path: "c", y: "M" }),
				],
			}),
		)?.text,
	).toBe("main • 3 changes • 2 commits ahead");
});

test("the compact status line carries behind, no upstream and detached", () => {
	expect(gitBar(status({ behind: 1 }))?.text).toBe(
		"main • 0 changes • 1 commit behind",
	);
	expect(gitBar(status({ upstream: null }))?.text).toBe(
		"main • 0 changes • no upstream",
	);
	expect(gitBar(status({ branch: null, detached: true, upstream: null }))?.text).toBe(
		"detached HEAD • 0 changes",
	);
});

test("conflicts show in the line and are counted for the conspicuous style", () => {
	const bar = gitBar(
		status({
			conflicts: 2,
			entries: [
				entry({ path: "a", unmerged: true, x: "U", y: "U" }),
				entry({ path: "b", unmerged: true, x: "U", y: "U" }),
			],
		}),
	);
	expect(bar?.text).toBe("main • 2 changes • 2 conflicts");
	expect(bar?.conflicts).toBe(2);
});

test("a truncated status marks the count, and no repository is said plainly", () => {
	expect(
		gitBar(status({ truncated: true, entries: [entry({ path: "a", y: "M" })] }))?.text,
	).toBe("main • more than 1 changes");
	expect(gitBar(status({ repo: false }))).toMatchObject({
		text: "not a git repository",
		repo: false,
	});
	expect(gitBar(undefined)).toBeNull();
});
