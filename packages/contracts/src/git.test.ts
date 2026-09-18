import { expect, test } from "vitest";
import {
	GitDiff,
	GitEntry,
	GitStatus,
	GitStatusQuery,
	MAX_DIFF_SIDE_BYTES,
	MAX_GIT_ENTRIES,
} from "./git.js";

test("a status entry carries one character per side and an optional old path", () => {
	expect(GitEntry.safeParse({ path: "a.ts", x: ".", y: "M" }).success).toBe(true);
	expect(
		GitEntry.safeParse({ path: "b.ts", x: "R", y: ".", origPath: "a.ts" }).success,
	).toBe(true);
	expect(GitEntry.safeParse({ path: "a.ts", x: "MM", y: "M" }).success).toBe(false);
	expect(GitEntry.safeParse({ path: "", x: "M", y: "M" }).success).toBe(false);
});

test("a repository status accepts a null branch for detached HEAD", () => {
	const parsed = GitStatus.safeParse({
		repo: true,
		branch: null,
		detached: true,
		upstream: null,
		ahead: 0,
		behind: 0,
		conflicts: 0,
		entries: [],
		ignored: [],
		truncated: false,
	});
	expect(parsed.success).toBe(true);
});

test("a diff status is one of the five kinds and both sides may be null", () => {
	expect(
		GitDiff.safeParse({
			status: "A",
			before: null,
			after: "hello",
			binary: false,
			tooLarge: false,
		}).success,
	).toBe(true);
	expect(
		GitDiff.safeParse({
			status: "X",
			before: null,
			after: null,
			binary: true,
			tooLarge: false,
		}).success,
	).toBe(false);
});

test("hidden defaults to false and parses as a boolean", () => {
	expect(GitStatusQuery.parse({}).hidden).toBe(false);
	expect(GitStatusQuery.parse({ hidden: "true" }).hidden).toBe(true);
	expect(GitStatusQuery.parse({ hidden: "false" }).hidden).toBe(false);
	expect(GitStatusQuery.safeParse({ hidden: "yes" }).success).toBe(false);
});

test("the caps are the ones SPEC.md §12.6 asks the agent to enforce", () => {
	expect(MAX_GIT_ENTRIES).toBe(5000);
	expect(MAX_DIFF_SIDE_BYTES).toBe(1024 * 1024);
});
