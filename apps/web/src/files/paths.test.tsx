import { describe, expect, it } from "vitest";
import {
	baseName,
	canMoveInto,
	isDescendant,
	isHiddenName,
	joinPath,
	nameError,
	parentOf,
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
