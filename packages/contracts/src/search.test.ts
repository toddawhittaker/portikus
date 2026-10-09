import { describe, expect, test } from "vitest";
import { SearchQuery, SearchResponse } from "./search.js";

describe("SearchQuery", () => {
	test("defaults hidden to false and keeps the query", () => {
		expect(SearchQuery.parse({ q: "todo" })).toMatchObject({
			q: "todo",
			hidden: false,
		});
	});

	test("coerces hidden from the query string", () => {
		expect(SearchQuery.parse({ q: "todo", hidden: "true" }).hidden).toBe(true);
	});

	test("rejects an empty or oversized query", () => {
		expect(SearchQuery.safeParse({ q: "" }).success).toBe(false);
		expect(SearchQuery.safeParse({ q: "x".repeat(513) }).success).toBe(false);
	});
});

test("a response carries matches and a truncation flag", () => {
	const parsed = SearchResponse.parse({
		matches: [
			{ path: "a.txt", line: 1, column: 2, text: "hit", before: [], after: ["next"] },
		],
		truncated: true,
	});
	expect(parsed.matches[0]?.path).toBe("a.txt");
	expect(parsed.truncated).toBe(true);
});

describe("SearchQuery options", () => {
	test("every option defaults to off", () => {
		expect(SearchQuery.parse({ q: "x" })).toEqual({
			q: "x",
			hidden: false,
			regex: false,
			caseSensitive: false,
			wholeWord: false,
		});
	});

	test("each option reads true and false as words", () => {
		const parsed = SearchQuery.parse({
			q: "x",
			regex: "true",
			caseSensitive: "true",
			wholeWord: "false",
		});
		expect(parsed).toMatchObject({
			regex: true,
			caseSensitive: true,
			wholeWord: false,
		});
	});

	test("an option that is not true or false is refused", () => {
		for (const name of ["regex", "caseSensitive", "wholeWord"]) {
			expect(SearchQuery.safeParse({ q: "x", [name]: "1" }).success).toBe(false);
		}
	});
});
