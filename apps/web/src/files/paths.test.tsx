import { describe, expect, it } from "vitest";
import {
	baseName,
	canMoveInto,
	displayName,
	isDescendant,
	isHiddenName,
	joinPath,
	moveForDrop,
	nameError,
	parentOf,
	prunePaths,
	reseedFocus,
	rewritePaths,
	tabIdsUnder,
	visibleEntries,
} from "./paths.js";

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

describe("the focused row", () => {
	it("keeps a row that is still on screen", () => {
		expect(reseedFocus("src/app.ts", ["src", "src/app.ts"])).toBe("src/app.ts");
	});

	it("falls back to the first row when the focused one is gone", () => {
		expect(reseedFocus("gone.txt", ["src", "README.md"])).toBe("src");
	});

	it("has nothing to focus in an empty tree", () => {
		expect(reseedFocus("gone.txt", [])).toBeNull();
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
		expect(moveForDrop("row:src/app.ts", "dir:tests")).toEqual({
			from: "src/app.ts",
			to: "tests/app.ts",
		});
	});

	it("moves a file back out to the project root", () => {
		expect(moveForDrop("row:src/app.ts", "dir:")).toEqual({
			from: "src/app.ts",
			to: "app.ts",
		});
	});

	it("asks for nothing on a drop that changes nothing", () => {
		expect(moveForDrop("row:src/app.ts", "dir:src")).toBeNull();
		expect(moveForDrop("row:src", "dir:src/lib")).toBeNull();
		expect(moveForDrop("row:src", null)).toBeNull();
	});
});
