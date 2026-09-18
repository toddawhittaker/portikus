import { describe, expect, test } from "vitest";
import {
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
