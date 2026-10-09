import { expect, test } from "vitest";
import {
	GitDiff,
	GitEntry,
	GitRef,
	GitStatus,
	GitStatusQuery,
	MAX_DIFF_SIDE_BYTES,
	MAX_GIT_ENTRIES,
} from "./git.js";

test("a status entry carries one character per side and an optional old path", () => {
	expect(
		GitEntry.safeParse({ path: "a.ts", x: ".", y: "M", unmerged: false }).success,
	).toBe(true);
	expect(
		GitEntry.safeParse({
			path: "b.ts",
			x: "R",
			y: ".",
			unmerged: false,
			origPath: "a.ts",
		}).success,
	).toBe(true);
	expect(
		GitEntry.safeParse({ path: "a.ts", x: "MM", y: "M", unmerged: false }).success,
	).toBe(false);
	expect(
		GitEntry.safeParse({ path: "", x: "M", y: "M", unmerged: false }).success,
	).toBe(false);
});

test("the conflict flag is required on every entry", () => {
	expect(GitEntry.safeParse({ path: "a.ts", x: "U", y: "U" }).success).toBe(false);
	expect(
		GitEntry.safeParse({ path: "a.ts", x: "U", y: "U", unmerged: true }).success,
	).toBe(true);
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

test("a ref is a branch, tag, commit id, or relative name", () => {
	for (const ref of [
		"main",
		"feature/x",
		"v1.0",
		"abc1234",
		"HEAD~2",
		"HEAD^",
		"@{u}",
	]) {
		expect(GitRef.safeParse(ref).success).toBe(true);
	}
});

test("a ref that could read as an option, a range, or a second line is refused", () => {
	for (const ref of [
		"",
		"-h",
		"--output=/tmp/x",
		"a..b",
		"a...b",
		"../x",
		"a\nb",
		"a\u0000b",
		"a\u007fb",
		"x".repeat(257),
	]) {
		expect(GitRef.safeParse(ref).success).toBe(false);
	}
	expect(GitRef.safeParse("x".repeat(256)).success).toBe(true);
});

test("a status without the commit id still parses, from an older agent", () => {
	const status = {
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
	};
	expect(GitStatus.parse(status).oid).toBeUndefined();
	expect(GitStatus.parse({ ...status, oid: "abc" }).oid).toBe("abc");
});
