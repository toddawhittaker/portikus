import { describe, expect, it } from "vitest";
import {
	baseName,
	canMoveInto,
	displayName,
	focusAfterRemoval,
	isDescendant,
	isHiddenName,
	joinPath,
	moveForDrop,
	nameError,
	parentOf,
	prunePaths,
	rewritePaths,
	tabIdsUnder,
	visibleEntries,
	withoutNested,
} from "./paths.js";

/** SPEC.md §11.2: deleting a folder already deletes what is inside it. */
describe("dropping paths covered by a selected folder", () => {
	it("keeps only the outermost paths", () => {
		expect(withoutNested(["src", "src/app.ts", "README.md"])).toEqual([
			"src",
			"README.md",
		]);
		expect(withoutNested(["src", "src/lib", "src/lib/deep.ts"])).toEqual(["src"]);
	});

	it("leaves a list with nothing nested alone", () => {
		expect(withoutNested(["src/app.ts", "README.md"])).toEqual([
			"src/app.ts",
			"README.md",
		]);
	});
});

describe("path arithmetic", () => {
	it("splits a path into its parent and its name", () => {
		expect(parentOf("src/app.ts")).toBe("src");
		expect(parentOf("README.md")).toBe("");
		expect(baseName("src/lib/app.ts")).toBe("app.ts");
		expect(baseName("README.md")).toBe("README.md");
	});

	it("joins onto the project root without a leading slash", () => {
		expect(joinPath("", "notes.txt")).toBe("notes.txt");
		expect(joinPath("src", "app.ts")).toBe("src/app.ts");
	});
});

/** SPEC.md §11.3: the default tree hides generated and dotted names. */
describe("the hidden and generated filter", () => {
	const entries = [
		{ name: "src" },
		{ name: "README.md" },
		{ name: ".env" },
		{ name: "node_modules" },
		{ name: "dist" },
		{ name: "__pycache__" },
	];

	it("names every generated directory and every dotfile as hidden", () => {
		expect(isHiddenName(".env")).toBe(true);
		expect(isHiddenName(".git")).toBe(true);
		expect(isHiddenName("node_modules")).toBe(true);
		expect(isHiddenName("dist")).toBe(true);
		expect(isHiddenName("src")).toBe(false);
		expect(isHiddenName("distance.txt")).toBe(false);
	});

	it("drops them by default and keeps them when Show hidden is on", () => {
		expect(visibleEntries(entries, false).map((entry) => entry.name)).toEqual([
			"src",
			"README.md",
		]);
		expect(visibleEntries(entries, true)).toHaveLength(entries.length);
	});
});

/** SPEC.md §11.1: a name is one segment, never a path. */
describe("name validation", () => {
	it("refuses an empty name, a dot name, and any separator", () => {
		expect(nameError("")).not.toBeNull();
		expect(nameError("   ")).not.toBeNull();
		expect(nameError(".")).not.toBeNull();
		expect(nameError("..")).not.toBeNull();
		expect(nameError("src/app.ts")).not.toBeNull();
		expect(nameError("src\\app.ts")).not.toBeNull();
		expect(nameError("bad\0name")).not.toBeNull();
		expect(nameError("a".repeat(256))).not.toBeNull();
	});

	it("accepts ordinary names, including dotfiles", () => {
		expect(nameError("notes.txt")).toBeNull();
		expect(nameError(".env")).toBeNull();
		expect(nameError("my file.md")).toBeNull();
	});
});

/** SPEC.md §11.2: a move stays inside the project and cannot eat itself. */
describe("the drop guard", () => {
	it("knows what is inside what", () => {
		expect(isDescendant("src/app.ts", "src")).toBe(true);
		expect(isDescendant("srcx/app.ts", "src")).toBe(false);
		expect(isDescendant("README.md", "")).toBe(true);
	});

	it("refuses a directory dropped into itself or into its own child", () => {
		expect(canMoveInto("src", "src")).toBe(false);
		expect(canMoveInto("src", "src/lib")).toBe(false);
		expect(canMoveInto("src", "src/lib/deep")).toBe(false);
	});

	it("refuses a drop back where the file already is", () => {
		expect(canMoveInto("src/app.ts", "src")).toBe(false);
		expect(canMoveInto("README.md", "")).toBe(false);
	});

	it("allows a real move, including out to the project root", () => {
		expect(canMoveInto("src/app.ts", "tests")).toBe(true);
		expect(canMoveInto("src/app.ts", "")).toBe(true);
		expect(canMoveInto("src", "tests")).toBe(true);
	});
});

/** SPEC.md §11.2: a deleted or moved directory takes its subtree with it. */
describe("keeping the open directories honest", () => {
	it("prunes a removed directory and everything under it", () => {
		expect(prunePaths(["src", "src/lib", "src/lib/deep", "tests"], "src")).toEqual([
			"tests",
		]);
	});

	it("rewrites a moved directory and everything under it", () => {
		expect(rewritePaths(["src", "src/lib", "tests"], "src", "app/src")).toEqual([
			"app/src",
			"app/src/lib",
			"tests",
		]);
	});
});

/** SPEC.md §25.8: a keyboard user keeps their place when the focused row goes. */
describe("the focused row", () => {
	const drawn = ["src", "src/a.ts", "src/b.ts", "src/c.ts", "README.md"];

	it("keeps a row that is still on screen", () => {
		expect(focusAfterRemoval("src/b.ts", drawn, drawn)).toBe("src/b.ts");
	});

	it("starts on the first row when nothing was focused", () => {
		expect(focusAfterRemoval(null, [], drawn)).toBe("src");
		expect(focusAfterRemoval(null, [], [])).toBeNull();
	});

	it("moves to the next sibling of a removed row", () => {
		const after = ["src", "src/a.ts", "src/c.ts", "README.md"];
		expect(focusAfterRemoval("src/b.ts", drawn, after)).toBe("src/c.ts");
	});

	it("moves to the row above when the removed row was the last in its folder", () => {
		const after = ["src", "src/a.ts", "src/b.ts", "README.md"];
		expect(focusAfterRemoval("src/c.ts", drawn, after)).toBe("src/b.ts");
	});

	it("moves to the folder when its only row is removed", () => {
		const before = ["src", "src/a.ts", "README.md"];
		expect(focusAfterRemoval("src/a.ts", before, ["src", "README.md"])).toBe("src");
	});

	it("treats a row inside a deleted folder as the folder", () => {
		expect(focusAfterRemoval("src/b.ts", drawn, ["README.md"])).toBe("README.md");
		const lib = ["lib", "src", "src/a.ts", "src/b.ts"];
		expect(focusAfterRemoval("src/a.ts", lib, ["lib"])).toBe("lib");
	});

	it("lands on a renamed row's new neighbour, not on the first row", () => {
		const after = ["src", "src/a.ts", "src/c.ts", "src/z.ts", "README.md"];
		expect(focusAfterRemoval("src/b.ts", drawn, after)).toBe("src/c.ts");
	});

	it("lands on the first loaded row when Show more is replaced by the rest", () => {
		const more = "src/\u0000more";
		const before = ["src", "src/a.ts", more, "README.md"];
		const after = ["src", "src/a.ts", "src/b.ts", "README.md"];
		expect(focusAfterRemoval(more, before, after)).toBe("src/b.ts");
	});

	it("falls back to the first row for a row it never drew", () => {
		expect(focusAfterRemoval("gone.txt", drawn, drawn)).toBe("src");
		expect(focusAfterRemoval("gone.txt", drawn, [])).toBeNull();
	});
});

describe("the tabs under a path", () => {
	it("matches the file itself and anything inside a directory", () => {
		const tabs = ["file:src/app.ts", "diff:src/app.ts", "file:src2/a.ts", "terminal-1"];
		expect(tabIdsUnder(tabs, "src")).toEqual(["file:src/app.ts", "diff:src/app.ts"]);
		expect(tabIdsUnder(tabs, "src/app.ts")).toEqual([
			"file:src/app.ts",
			"diff:src/app.ts",
		]);
		expect(tabIdsUnder(tabs, "other")).toEqual([]);
	});
});

/** SPEC.md §24.6: a name must not be able to draw itself as something else. */
describe("displayName", () => {
	const bell = String.fromCharCode(0x07);
	const rightToLeftOverride = String.fromCharCode(0x202e);
	const isolate = String.fromCharCode(0x2066);

	it("strips control and bidirectional characters", () => {
		expect(displayName(`a${rightToLeftOverride}b${bell}c${isolate}d`)).toBe("abcd");
		expect(displayName("report.pdf")).toBe("report.pdf");
	});
});

/** SPEC.md §11.2: a drop asks for the move the student drew. */
describe("moveForDrop", () => {
	it("moves the dragged file into the directory under it", () => {
		expect(moveForDrop("src/app.ts", "tests")).toEqual({
			from: "src/app.ts",
			to: "tests/app.ts",
		});
	});

	it("moves a file back out to the project root", () => {
		expect(moveForDrop("src/app.ts", "")).toEqual({
			from: "src/app.ts",
			to: "app.ts",
		});
	});

	it("asks for nothing on a drop that changes nothing", () => {
		expect(moveForDrop("src/app.ts", "src")).toBeNull();
		expect(moveForDrop("src", "src/lib")).toBeNull();
		expect(moveForDrop("src", null)).toBeNull();
	});
});
