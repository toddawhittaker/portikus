import { describe, expect, test } from "vitest";
import { TREE_DRAG_TYPE } from "../files/useTreeDragAndDrop.js";
import {
	DROP_FOLDER_TRIES,
	dropKind,
	dropNameError,
	dropPaths,
	droppedPathsInput,
	shellQuotePath,
} from "./terminalDrop.js";

describe("shellQuotePath", () => {
	test("a path of plain characters stays bare", () => {
		expect(shellQuotePath("/home/student/projects/a/b-c_d.png")).toBe(
			"/home/student/projects/a/b-c_d.png",
		);
		expect(shellQuotePath("a@b%c+d=e:f,g")).toBe("a@b%c+d=e:f,g");
	});

	test("spaces and shell characters are single-quoted", () => {
		expect(shellQuotePath("/p/my shot.png")).toBe("'/p/my shot.png'");
		expect(shellQuotePath("/p/$(rm -rf ~).png")).toBe("'/p/$(rm -rf ~).png'");
		expect(shellQuotePath('/p/a;b&c|d`e"f\\g.png')).toBe("'/p/a;b&c|d`e\"f\\g.png'");
		expect(shellQuotePath("/p/~x*?[a]#!.png")).toBe("'/p/~x*?[a]#!.png'");
	});

	test("each single quote is closed, escaped and reopened", () => {
		expect(shellQuotePath("/p/it's.png")).toBe("'/p/it'\\''s.png'");
		expect(shellQuotePath("'")).toBe("''\\'''");
	});

	test("unicode is quoted, not refused", () => {
		expect(shellQuotePath("/p/café 画像.png")).toBe("'/p/café 画像.png'");
		expect(shellQuotePath("/p/😀.png")).toBe("'/p/😀.png'");
	});

	test("an empty path becomes an empty quoted word", () => {
		expect(shellQuotePath("")).toBe("''");
	});

	test.each([
		["NUL", 0],
		["a low control character", 1],
		["backspace", 8],
		["tab", 9],
		["line feed", 10],
		["vertical tab", 11],
		["carriage return", 13],
		["escape", 27],
		["the last of the low range", 31],
		["delete", 127],
		["the first C1 control", 128],
		["the C1 CSI", 155],
		["the last C1 control", 159],
	])("%s is refused", (_label, code) => {
		const path = `/p/a${String.fromCharCode(code)}b.png`;
		expect(shellQuotePath(path)).toBeNull();
		expect(shellQuotePath(String.fromCharCode(code))).toBeNull();
	});

	test("the characters just outside the control ranges are allowed", () => {
		const nbsp = String.fromCharCode(160);
		expect(shellQuotePath("a b")).toBe("'a b'");
		expect(shellQuotePath(`a${nbsp}b`)).toBe(`'a${nbsp}b'`);
	});

	test("a newline never reaches the output", () => {
		for (const path of ["a\nb", "'\n'", "/p/x\r\ny"]) {
			expect(shellQuotePath(path)).toBeNull();
		}
	});
});

describe("dropKind", () => {
	test("tree rows win over files, and anything else is ignored", () => {
		expect(dropKind([TREE_DRAG_TYPE])).toBe("tree");
		expect(dropKind(["Files"])).toBe("files");
		expect(dropKind(["Files", TREE_DRAG_TYPE])).toBe("tree");
		expect(dropKind(["text/plain"])).toBeNull();
		expect(dropKind([])).toBeNull();
	});
});

describe("dropNameError", () => {
	test("accepts ordinary names, spaces included", () => {
		expect(dropNameError("Screen Shot 2026-11-01.png")).toBeNull();
		expect(dropNameError("it's.png")).toBeNull();
	});

	test("refuses control characters, slashes and empty names", () => {
		expect(dropNameError("a\nb.png")).not.toBeNull();
		expect(dropNameError("a\u001bb.png")).not.toBeNull();
		expect(dropNameError("a\u009bb.png")).not.toBeNull();
		expect(dropNameError("a/b.png")).not.toBeNull();
		expect(dropNameError("")).not.toBeNull();
	});
});

describe("dropPaths", () => {
	test("names a dated folder, then numbered ones", () => {
		const paths = dropPaths(new Date("2026-11-01T13:40:05.123Z"), "my shot.png");
		expect(paths).toHaveLength(DROP_FOLDER_TRIES);
		expect(paths[0]).toBe(".portikus/pastes/2026-11-01T13-40-05/my shot.png");
		expect(paths[1]).toBe(".portikus/pastes/2026-11-01T13-40-05-2/my shot.png");
	});
});

describe("droppedPathsInput", () => {
	test("types absolute quoted paths separated by spaces, with one space after", () => {
		expect(droppedPathsInput("demo", ["a.png", "my dir/b c.png"])).toBe(
			"/home/student/projects/demo/a.png '/home/student/projects/demo/my dir/b c.png' ",
		);
	});

	test("one refused path refuses all", () => {
		expect(droppedPathsInput("demo", ["a.png", "b\nc.png"])).toBeNull();
	});

	test("nothing to type gives null", () => {
		expect(droppedPathsInput("demo", [])).toBeNull();
	});

	test("never contains a newline", () => {
		expect(droppedPathsInput("demo", ["a.png", "b c.png"])).not.toMatch(/[\r\n]/);
	});
});
