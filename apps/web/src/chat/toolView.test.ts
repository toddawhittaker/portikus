import { expect, test } from "vitest";
import { diffLines, previewText, projectPath, toolLine, toolView } from "./toolView";

test("a row names the kind of tool, its verb and what it acted on", () => {
	expect(toolLine("Read", { file_path: "src/a.ts" }, "Read a file")).toEqual({
		icon: "file",
		verb: { done: "Read", doing: "Reading", pending: "Read" },
		target: "a.ts",
		literal: true,
		path: "src/a.ts",
		added: 0,
		removed: 0,
		detail: null,
	});
	expect(toolLine("Write", { file_path: "b.md", content: "x" }, "").path).toBeNull();
	expect(toolLine("Grep", { pattern: "x", path: "src" }, "").target).toBe("x in src");
	expect(toolLine("Glob", { pattern: "*.ts" }, "").icon).toBe("list");
	expect(toolLine("WebSearch", { query: "zod" }, "").verb?.done).toBe(
		"Searched the web for",
	);
	expect(toolLine("Bash", { command: "ls" }, "").icon).toBe("terminal");
	const notebook = toolLine("NotebookEdit", { notebook_path: "nb/plot.ipynb" }, "");
	expect([notebook.verb?.done, notebook.target, notebook.path]).toEqual([
		"Edited",
		"plot.ipynb",
		"nb/plot.ipynb",
	]);
});

test("a one-line command is left out of the opened row; a longer one stays", () => {
	expect(toolLine("Bash", { command: "pnpm test" }, "").detail).toBeNull();
	expect(toolLine("Bash", { command: "a\nb" }, "").detail).toEqual({
		kind: "command",
		command: "a\nb",
	});
});

test("an edit counts the lines it added and removed across its changes", () => {
	const line = toolLine(
		"MultiEdit",
		{
			file_path: "a.ts",
			edits: [
				{ old_string: "x\ny", new_string: "x\nz" },
				{ old_string: "1", new_string: "2\n3" },
			],
		},
		"",
	);
	expect([line.added, line.removed]).toEqual([3, 2]);
});

test("an unknown tool, or input without what the verb needs, keeps the title", () => {
	expect(toolLine("Screenshot", { url: "x" }, "the page")).toMatchObject({
		icon: "box",
		verb: null,
		target: "the page",
		literal: false,
	});
	expect(toolLine("Read", {}, "Read it")).toMatchObject({
		verb: null,
		target: "Read it",
	});
	expect(toolLine("Read", "nonsense", "t").verb).toBeNull();
});

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

test("a path under the project's directory becomes the project's own path", () => {
	expect(projectPath("demo", "/home/student/projects/demo/src/a.ts")).toBe("src/a.ts");
	expect(projectPath("demo", "src/a.ts")).toBe("src/a.ts");
	expect(projectPath(undefined, "src/a.ts")).toBe("src/a.ts");
});

test("a path outside the project, or before the slug is known, is not the project's", () => {
	expect(projectPath("demo", "/home/student/projects/demo-2/a.ts")).toBeNull();
	expect(projectPath("demo", "/home/student/projects/demo/")).toBeNull();
	expect(projectPath("demo", "/home/student/.bashrc")).toBeNull();
	expect(projectPath(undefined, "/home/student/projects/demo/a.ts")).toBeNull();
});

test("a path is normalised: . and empty segments go, and .. is resolved inside the project", () => {
	expect(projectPath("demo", "./src//a.ts")).toBe("src/a.ts");
	expect(projectPath("demo", "src/../a.ts")).toBe("a.ts");
	expect(projectPath("demo", "/home/student/projects/demo/src/./a.ts")).toBe(
		"src/a.ts",
	);
	// The same file by a relative and an absolute path is one path.
	expect(projectPath("demo", "/home/student/projects/demo/src/a.ts")).toBe(
		projectPath("demo", "./src/a.ts"),
	);
});

test("a path that leaves the project, or cannot be a ProjectPath, is not the project's", () => {
	expect(projectPath("demo", "../x")).toBeNull();
	expect(projectPath("demo", "src/../../x")).toBeNull();
	expect(projectPath("demo", "/home/student/projects/demo/../x")).toBeNull();
	expect(projectPath("demo", "/home/student/projects/demo/../demo-2/x")).toBeNull();
	expect(projectPath("demo", "src\\a.ts")).toBeNull();
	expect(projectPath("demo", "a\0b")).toBeNull();
	expect(projectPath("demo", "")).toBeNull();
	expect(projectPath("demo", ".")).toBeNull();
});
