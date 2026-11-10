import { describe, expect, test } from "vitest";
import {
	contentDisposition,
	FileNameSearchRequest,
	FileNameSearchResponse,
	MAX_EDITOR_FILE_BYTES,
	MAX_UPLOAD_BYTES,
	MkdirRequest,
	MoveRequest,
	ProjectPath,
} from "./files.js";

describe("ProjectPath", () => {
	test("accepts ordinary project-relative paths", () => {
		for (const path of ["notes.txt", "src/main.ts", "a/b/c.txt", ".env", "..hidden"]) {
			expect(ProjectPath.safeParse(path).success).toBe(true);
		}
	});

	test("refuses anything that could leave the project (SPEC.md §24.6)", () => {
		for (const path of [
			"",
			"/etc/passwd",
			"../beta",
			"a/../../b",
			"./a",
			"a/./b",
			"a\\b",
			"a\0b",
			"x".repeat(1025),
		]) {
			expect(ProjectPath.safeParse(path).success).toBe(false);
		}
	});
});

test("requests reject unknown keys", () => {
	expect(MkdirRequest.safeParse({ path: "src" }).success).toBe(true);
	expect(MkdirRequest.safeParse({ path: "src", extra: 1 }).success).toBe(false);
	expect(MoveRequest.safeParse({ from: "a", to: "b" }).success).toBe(true);
	expect(MoveRequest.safeParse({ from: "a" }).success).toBe(false);
});

test("an upload may be larger than anything the editor opens", () => {
	expect(MAX_UPLOAD_BYTES).toBeGreaterThan(MAX_EDITOR_FILE_BYTES);
});

describe("contentDisposition", () => {
	test("keeps a plain ASCII name as it is", () => {
		expect(contentDisposition("report.txt")).toBe(
			`attachment; filename="report.txt"; filename*=UTF-8''report.txt`,
		);
	});

	test("drops control characters so a name cannot inject a header", () => {
		const header = contentDisposition("bad\r\nname \u2603.txt");
		expect(header).not.toMatch(/[\r\n]/);
		expect(header).toContain('filename="badname _.txt"');
		expect(header).toContain("%E2%98%83");
	});

	test("falls back to download when nothing ASCII is left", () => {
		expect(contentDisposition("\u2603\u2603")).toContain('filename="download"');
	});
});

describe("file-name search", () => {
	test("the request defaults its limit to 20", () => {
		expect(FileNameSearchRequest.parse({ query: "app" })).toEqual({
			query: "app",
			limit: 20,
		});
	});

	test("the request keeps the query and limit in range", () => {
		const ok = (body: object) => FileNameSearchRequest.safeParse(body).success;
		expect(ok({ query: "" })).toBe(true);
		expect(ok({ query: "q".repeat(200) })).toBe(true);
		expect(ok({ query: "q".repeat(201) })).toBe(false);
		expect(ok({ limit: 5 })).toBe(false);
		expect(ok({ query: "a", limit: 1 })).toBe(true);
		expect(ok({ query: "a", limit: 50 })).toBe(true);
		expect(ok({ query: "a", limit: 0 })).toBe(false);
		expect(ok({ query: "a", limit: 51 })).toBe(false);
		expect(ok({ query: "a", limit: 2.5 })).toBe(false);
	});

	test("the response holds at most 50 paths and says if it was cut", () => {
		const ok = (paths: string[], truncated = false) =>
			FileNameSearchResponse.safeParse({ paths, truncated }).success;
		expect(ok([])).toBe(true);
		expect(
			ok(
				Array.from({ length: 50 }, (_, i) => `src/f${i}.ts`),
				true,
			),
		).toBe(true);
		expect(ok(Array.from({ length: 51 }, (_, i) => `src/f${i}.ts`))).toBe(false);
		expect(FileNameSearchResponse.safeParse({ paths: [] }).success).toBe(false);
	});
});
