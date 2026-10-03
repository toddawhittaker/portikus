import { describe, expect, it } from "vitest";
import { EMPTY_SELECTION, selectionAfterClick } from "./selection.js";
import {
	nextTypeAhead,
	selectionAfterExtend,
	TYPE_AHEAD_RESET_MS,
	typeAheadIndex,
} from "./treeKeys.js";

const ORDER = ["src", "src/app.ts", "src/util.ts", "README.md", "notes.md"];
const NAMES = ["src", "app.ts", "util.ts", "README.md", "notes.md"];
const PLAIN = { toggle: false, range: false };

/** The APG tree view pattern's type-ahead, on the rows drawn (SPEC.md §25.8). */
describe("the file tree type-ahead", () => {
	it("finds the next row whose name starts with the typed text", () => {
		expect(typeAheadIndex(NAMES, 0, "a")).toBe(1);
		expect(typeAheadIndex(NAMES, 0, "re")).toBe(3);
	});

	it("ignores case", () => {
		expect(typeAheadIndex(NAMES, 0, "r")).toBe(3);
		expect(typeAheadIndex(NAMES, 0, "N")).toBe(4);
	});

	it("moves past the current row on a single letter and wraps round", () => {
		// On "util.ts", typing "u" again finds nothing else, so it stays put.
		expect(typeAheadIndex(NAMES, 2, "u")).toBe(2);
		// From "notes.md", "s" wraps to "src" at the top.
		expect(typeAheadIndex(NAMES, 4, "s")).toBe(0);
	});

	it("keeps the current row while a longer prefix still fits it", () => {
		expect(typeAheadIndex(NAMES, 3, "rea")).toBe(3);
	});

	it("cycles through rows when one letter is pressed again and again", () => {
		const names = ["a1", "b", "a2", "a3"];
		expect(typeAheadIndex(names, 0, "aa")).toBe(2);
		expect(typeAheadIndex(names, 2, "aaa")).toBe(3);
	});

	it("says when nothing matches", () => {
		expect(typeAheadIndex(NAMES, 0, "zz")).toBe(-1);
		expect(typeAheadIndex([], 0, "a")).toBe(-1);
	});

	it("adds to the typed text, and starts again after a pause", () => {
		const first = nextTypeAhead({ text: "", at: 0 }, "r", 1000);
		expect(first).toEqual({ text: "r", at: 1000 });
		const second = nextTypeAhead(first, "e", 1000 + TYPE_AHEAD_RESET_MS - 1);
		expect(second.text).toBe("re");
		const fresh = nextTypeAhead(second, "n", second.at + TYPE_AHEAD_RESET_MS + 1);
		expect(fresh.text).toBe("n");
	});
});

/** Shift+Arrow extends the selection, the way Shift-click does (SPEC.md §11.2). */
describe("extending the selection from the keyboard", () => {
	it("runs from the anchor to the row the focus moved to", () => {
		const one = selectionAfterClick(EMPTY_SELECTION, "src/app.ts", PLAIN, ORDER);
		const two = selectionAfterExtend(one, "src/app.ts", "src/util.ts", ORDER);
		expect(two).toEqual({ paths: ["src/app.ts", "src/util.ts"], anchor: "src/app.ts" });
		const three = selectionAfterExtend(two, "src/util.ts", "README.md", ORDER);
		expect(three.paths).toEqual(["src/app.ts", "src/util.ts", "README.md"]);
	});

	it("shrinks again when the focus comes back towards the anchor", () => {
		const start = { paths: ["src/app.ts", "src/util.ts"], anchor: "src/app.ts" };
		const back = selectionAfterExtend(start, "src/util.ts", "src/app.ts", ORDER);
		expect(back.paths).toEqual(["src/app.ts"]);
	});

	it("anchors on the row the focus left when nothing is selected yet", () => {
		const run = selectionAfterExtend(EMPTY_SELECTION, "README.md", "notes.md", ORDER);
		expect(run).toEqual({ paths: ["README.md", "notes.md"], anchor: "README.md" });
	});
});
