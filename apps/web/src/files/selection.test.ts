import { describe, expect, it } from "vitest";
import {
	actionTargets,
	EMPTY_SELECTION,
	orderedSelection,
	pruneSelection,
	type Selection,
	selectionAfterClick,
} from "./selection.js";

const ORDER = ["src", "src/app.ts", "src/util.ts", "README.md", "notes.md"];
const PLAIN = { toggle: false, range: false };
const TOGGLE = { toggle: true, range: false };
const RANGE = { toggle: false, range: true };

/** SPEC.md §11.2: selecting rows in the files pane. */
describe("the file tree selection", () => {
	it("selects one row on a plain click", () => {
		const first = selectionAfterClick(EMPTY_SELECTION, "README.md", PLAIN, ORDER);
		expect(first).toEqual({ paths: ["README.md"], anchor: "README.md" });

		const second = selectionAfterClick(first, "notes.md", PLAIN, ORDER);
		expect(second).toEqual({ paths: ["notes.md"], anchor: "notes.md" });
	});

	it("adds and removes one row on a Ctrl-click", () => {
		const one = selectionAfterClick(EMPTY_SELECTION, "src/app.ts", PLAIN, ORDER);
		const two = selectionAfterClick(one, "notes.md", TOGGLE, ORDER);
		expect(two.paths).toEqual(["src/app.ts", "notes.md"]);
		expect(two.anchor).toBe("notes.md");

		const back = selectionAfterClick(two, "src/app.ts", TOGGLE, ORDER);
		expect(back.paths).toEqual(["notes.md"]);
	});

	it("selects the contiguous run on a Shift-click", () => {
		const anchor = selectionAfterClick(EMPTY_SELECTION, "src/app.ts", PLAIN, ORDER);
		const run = selectionAfterClick(anchor, "README.md", RANGE, ORDER);
		expect(run.paths).toEqual(["src/app.ts", "src/util.ts", "README.md"]);
		// The anchor stays put, so widening the run works from the same row.
		expect(run.anchor).toBe("src/app.ts");

		const wider = selectionAfterClick(run, "notes.md", RANGE, ORDER);
		expect(wider.paths).toEqual(["src/app.ts", "src/util.ts", "README.md", "notes.md"]);
	});

	it("runs backwards as well as forwards", () => {
		const anchor = selectionAfterClick(EMPTY_SELECTION, "notes.md", PLAIN, ORDER);
		const run = selectionAfterClick(anchor, "src/util.ts", RANGE, ORDER);
		expect(run.paths).toEqual(["src/util.ts", "README.md", "notes.md"]);
	});

	it("treats a Shift-click with no anchor as a plain click", () => {
		const run = selectionAfterClick(EMPTY_SELECTION, "notes.md", RANGE, ORDER);
		expect(run).toEqual({ paths: ["notes.md"], anchor: "notes.md" });
	});

	it("acts on the whole selection only when the row is part of it", () => {
		const selection: Selection = {
			paths: ["README.md", "notes.md"],
			anchor: "README.md",
		};
		expect(actionTargets(selection, "notes.md")).toEqual(["README.md", "notes.md"]);
		expect(actionTargets(selection, "src/app.ts")).toEqual(["src/app.ts"]);
	});

	it("forgets rows that are no longer drawn", () => {
		const selection: Selection = { paths: ["README.md", "gone.md"], anchor: "gone.md" };
		expect(pruneSelection(selection, ORDER)).toEqual({
			paths: ["README.md"],
			anchor: null,
		});
		// Nothing to drop means the same object, so React sees no change.
		const kept: Selection = { paths: ["README.md"], anchor: "README.md" };
		expect(pruneSelection(kept, ORDER)).toBe(kept);
	});

	it("lists the selection in the order the rows are drawn", () => {
		const selection: Selection = {
			paths: ["notes.md", "src/app.ts"],
			anchor: "notes.md",
		};
		expect(orderedSelection(selection, ORDER)).toEqual(["src/app.ts", "notes.md"]);
	});
});
