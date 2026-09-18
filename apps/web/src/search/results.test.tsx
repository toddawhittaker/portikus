import type { SearchMatch } from "@portikus/contracts";
import { expect, test } from "vitest";
import { groupByFile, highlightParts } from "./results.js";

function match(overrides: Partial<SearchMatch> = {}): SearchMatch {
	return {
		path: "src/app.ts",
		line: 3,
		column: 7,
		text: "const answer = 42;",
		before: [],
		after: [],
		...overrides,
	};
}

test("matches are grouped by file in the order the files first appeared", () => {
	const groups = groupByFile([
		match({ path: "src/a.ts", line: 1 }),
		match({ path: "src/b.ts", line: 2 }),
		match({ path: "src/a.ts", line: 9 }),
	]);

	expect(groups.map((group) => group.path)).toEqual(["src/a.ts", "src/b.ts"]);
	expect(groups[0]?.matches.map((item) => item.line)).toEqual([1, 9]);
	expect(groups[1]?.matches).toHaveLength(1);
});

test("no matches is no groups", () => {
	expect(groupByFile([])).toEqual([]);
});

test("the highlight splits the line at the 1-based column", () => {
	expect(highlightParts("const answer = 42;", 7, 6)).toEqual({
		before: "const ",
		match: "answer",
		after: " = 42;",
	});
});

test("a match at the start of the line has nothing before it", () => {
	expect(highlightParts("answer = 42;", 1, 6)).toEqual({
		before: "",
		match: "answer",
		after: " = 42;",
	});
});

test("a column past the 300-character slice highlights nothing", () => {
	// The agent sends at most 300 characters of a line, but the column counts
	// the whole line, so it can point past what was sent (SPEC.md §11.5).
	const text = "x".repeat(300);

	const parts = highlightParts(text, 512, 4);

	expect(parts.before).toBe(text);
	expect(parts.match).toBe("");
	expect(parts.after).toBe("");
});

test("a match running past the end of the slice stops at the end", () => {
	const text = "x".repeat(300);

	const parts = highlightParts(text, 298, 10);

	expect(parts.before).toHaveLength(297);
	expect(parts.match).toBe("xxx");
	expect(parts.after).toBe("");
});
