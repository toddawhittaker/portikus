import { expect, test } from "vitest";
import { diffLines, previewText, toolView } from "./toolView";

test("common tools read as their command, path, pattern or address", () => {
	expect(toolView("Bash", { command: "pnpm test\n--run" }, "Run tests")).toEqual({
		summary: "pnpm test …",
		literal: true,
		detail: { kind: "command", command: "pnpm test\n--run" },
	});
	expect(toolView("Read", { file_path: "src/a.ts" }, "").summary).toBe("src/a.ts");
	expect(toolView("Grep", { pattern: "TODO", path: "src" }, "").summary).toBe(
		"TODO in src",
	);
	expect(toolView("Grep", { pattern: "TODO", glob: "*.ts" }, "").summary).toBe(
		"TODO in *.ts",
	);
	expect(toolView("Grep", { pattern: "TODO" }, "").summary).toBe("TODO");
	expect(toolView("Glob", { pattern: "**/*.css", path: "web" }, "").summary).toBe(
		"**/*.css in web",
	);
	expect(toolView("Glob", { pattern: "**/*.css" }, "").summary).toBe("**/*.css");
	expect(toolView("WebFetch", { url: "https://example.com" }, "").summary).toBe(
		"https://example.com",
	);
	expect(toolView("WebSearch", { query: "zod enums" }, "")).toEqual({
		summary: "zod enums",
		literal: false,
		detail: null,
	});
});

test("an edit and a write carry their file and change", () => {
	expect(
		toolView("Edit", { file_path: "a.ts", old_string: "x", new_string: "y" }, "")
			.detail,
	).toEqual({ kind: "edit", path: "a.ts", changes: [{ before: "x", after: "y" }] });
	expect(
		toolView(
			"MultiEdit",
			{
				file_path: "a.ts",
				edits: [{ old_string: "1", new_string: "2" }, { nonsense: true }],
			},
			"",
		).detail,
	).toEqual({ kind: "edit", path: "a.ts", changes: [{ before: "1", after: "2" }] });
	expect(toolView("MultiEdit", { file_path: "a.ts", edits: [] }, "").detail).toBeNull();
	expect(toolView("Edit", { file_path: "a.ts" }, "").detail).toBeNull();
	expect(toolView("Write", { file_path: "b.md", content: "# Hi" }, "").detail).toEqual({
		kind: "write",
		path: "b.md",
		content: "# Hi",
	});
	expect(toolView("Write", { file_path: "b.md" }, "").detail).toBeNull();
	expect(toolView("Write", { notebook_path: "n.ipynb" }, "").summary).toBe("n.ipynb");
});

test("an unknown tool, or input missing what is expected, falls back to the title", () => {
	const fallback = { summary: "the home page", literal: false, detail: null };
	expect(toolView("Screenshot", { url: "x" }, "the home page")).toEqual(fallback);
	expect(toolView("Bash", "not an object", "the home page")).toEqual(fallback);
	for (const name of [
		"Bash",
		"Read",
		"Edit",
		"Write",
		"Grep",
		"Glob",
		"WebFetch",
		"WebSearch",
	]) {
		expect(toolView(name, {}, "the home page")).toEqual(fallback);
	}
});

test("a diff keeps shared lines as context around what changed", () => {
	expect(diffLines("a\nb\nc", "a\nB\nc")).toEqual([
		{ kind: "same", text: "a" },
		{ kind: "removed", text: "b" },
		{ kind: "added", text: "B" },
		{ kind: "same", text: "c" },
	]);
	expect(diffLines("x", "x\ny")).toEqual([
		{ kind: "same", text: "x" },
		{ kind: "added", text: "y" },
	]);
	expect(diffLines("", "new")).toEqual([
		{ kind: "removed", text: "" },
		{ kind: "added", text: "new" },
	]);
});

test("long text is cut to its first lines, and trailing blank lines do not count", () => {
	expect(previewText("a\nb\n\n", 2)).toEqual({ shown: "a\nb", hidden: 0 });
	expect(previewText("1\n2\n3\n4", 2)).toEqual({ shown: "1\n2", hidden: 2 });
	expect(previewText("one")).toEqual({ shown: "one", hidden: 0 });
});
