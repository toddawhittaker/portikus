import { expect, test } from "vitest";
import {
	collabReceivers,
	diffLines,
	isPlanCall,
	mcpCall,
	previewText,
	projectPath,
	toolLabel,
	toolLine,
	toolView,
} from "./toolView";

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

/** What a row reads as when it is done: the verb and what it acted on. */
function said(name: string, input: unknown, title = "") {
	const line = toolLine(name, input, title);
	return `${line.verb?.done ?? name}${line.target ? ` ${line.target}` : ""}`;
}

test("a Codex command reads as the one action Codex saw in it", () => {
	const row = (action: unknown, command = "cat src/a.ts") =>
		said("commandExecution", { command, actions: [action] });
	expect(row({ type: "read", path: "src/a.ts" })).toBe("Read a.ts");
	expect(row({ type: "listFiles", path: "src" }, "ls src")).toBe("Listed files in src");
	expect(row({ type: "listFiles", path: null }, "ls")).toBe("Listed files");
	expect(row({ type: "search", query: "todo", path: null }, "rg todo")).toBe(
		"Searched for todo",
	);
	expect(row({ type: "search", query: "todo", path: "src" }, "rg todo src")).toBe(
		"Searched for todo in src",
	);
	const read = toolLine(
		"commandExecution",
		{
			command: "cat src/a.ts",
			actions: [{ type: "read", path: "src/a.ts" }],
		},
		"",
	);
	expect([read.icon, read.path, read.detail]).toEqual([
		"file",
		"src/a.ts",
		{ kind: "command", command: "cat src/a.ts" },
	]);
	// The tenses of a running and of a refused call.
	expect(
		toolLine(
			"commandExecution",
			{ command: "ls", actions: [{ type: "listFiles", path: "src" }] },
			"",
		).verb,
	).toEqual({
		done: "Listed files in",
		doing: "Listing files in",
		pending: "List files in",
	});
});

test("a Codex command with no known action, or several, reads as the command", () => {
	for (const actions of [
		[{ type: "unknown" }],
		[],
		undefined,
		[
			{ type: "read", path: "a" },
			{ type: "read", path: "b" },
		],
		[{ type: "read", path: null }],
		[{ type: "search", query: null, path: "src" }],
		["nonsense"],
	]) {
		const line = toolLine("commandExecution", { command: "make test", actions }, "");
		expect([line.icon, line.verb?.done, line.target, line.detail]).toEqual([
			"terminal",
			"Ran",
			"make test",
			null,
		]);
	}
	expect(toolLine("commandExecution", { actions: [] }, "Run it")).toMatchObject({
		verb: null,
		target: "Run it",
	});
	// A long command keeps its full text in the opened row.
	expect(
		toolLine("commandExecution", { command: "a\nb", actions: [] }, "").detail,
	).toEqual({ kind: "command", command: "a\nb" });
});

const UPDATE_DIFF = "@@ -1,3 +1,3 @@\n keep\n-old\n+new\n tail\n";

test("a Codex file change reads each file's unified diff", () => {
	const view = toolView(
		"fileChange",
		{ changes: [{ path: "/p/a.ts", kind: "update", diff: UPDATE_DIFF }] },
		"",
	);
	expect(view.detail).toEqual({
		kind: "files",
		files: [
			{
				path: "/p/a.ts",
				kind: "update",
				movePath: null,
				added: 1,
				removed: 1,
				lines: [
					{ kind: "same", text: "@@ -1,3 +1,3 @@" },
					{ kind: "same", text: "keep" },
					{ kind: "removed", text: "old" },
					{ kind: "added", text: "new" },
					{ kind: "same", text: "tail" },
				],
			},
		],
	});
});

test("a file change's header lines and no-newline marks are not drawn", () => {
	const diff = "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n\\ No newline at end of file\n";
	const view = toolView(
		"fileChange",
		{ changes: [{ path: "x", kind: "update", diff }] },
		"",
	);
	const lines = view.detail?.kind === "files" ? view.detail.files[0]?.lines : [];
	expect(lines?.map((line) => `${line.kind}:${line.text}`)).toEqual([
		"same:@@ -1 +1 @@",
		"removed:a",
		"added:b",
	]);
});

test("a new file's content is all added, and a deleted file's is all removed", () => {
	const line = toolLine(
		"fileChange",
		{
			changes: [{ path: "/p/new.txt", kind: "add", diff: "one\ntwo\n" }],
		},
		"",
	);
	expect([line.verb?.done, line.target, line.added, line.removed, line.path]).toEqual([
		"Created",
		"/p/new.txt",
		2,
		0,
		null,
	]);
	const gone = toolLine(
		"fileChange",
		{ changes: [{ path: "/p/old.txt", kind: "delete", diff: "x\ny\nz\n" }] },
		"",
	);
	expect([gone.verb?.done, gone.added, gone.removed]).toEqual(["Deleted", 0, 3]);
	// A full diff of a new file is read the same way.
	const full = toolLine(
		"fileChange",
		{ changes: [{ path: "n", kind: "add", diff: "@@ -0,0 +1,2 @@\n+a\n+b\n" }] },
		"",
	);
	expect([full.added, full.removed]).toEqual([2, 0]);
});

test("a moved file, a mix of changes and a pair of files each read plainly", () => {
	const moved = toolLine(
		"fileChange",
		{
			changes: [
				{
					path: "/p/a.ts",
					kind: "update",
					movePath: "/p/b.ts",
					diff: "@@ -1 +1 @@\n-x\n+y\n",
				},
			],
		},
		"",
	);
	expect([moved.verb?.done, moved.target]).toEqual(["Moved", "/p/b.ts"]);
	const mixed = toolLine(
		"fileChange",
		{
			changes: [
				{ path: "a", kind: "add", diff: "1\n" },
				{ path: "b", kind: "delete", diff: "2\n3\n" },
			],
		},
		"",
	);
	expect([mixed.verb?.done, mixed.target, mixed.added, mixed.removed]).toEqual([
		"Changed",
		"2 files",
		1,
		2,
	]);
	const same = toolLine(
		"fileChange",
		{
			changes: [
				{ path: "a", kind: "update", diff: UPDATE_DIFF },
				{ path: "b", kind: "update", diff: UPDATE_DIFF },
			],
		},
		"",
	);
	expect([same.verb?.done, same.target]).toEqual(["Edited", "2 files"]);
	// Codex's own kind object is read too.
	const raw = toolView(
		"fileChange",
		{
			changes: [
				{ path: "a", kind: { type: "update", move_path: "c" }, diff: "" },
				{ path: "b", kind: { type: "weird" }, diff: "" },
				"not a change",
			],
		},
		"",
	);
	expect(raw.detail?.kind === "files" && raw.detail.files.map((f) => f.kind)).toEqual([
		"move",
	]);
});

test("a file change with nothing readable keeps its title", () => {
	expect(toolLine("fileChange", { changes: [] }, "Changed files")).toMatchObject({
		verb: null,
		target: "Changed files",
	});
	expect(toolLine("fileChange", { changes: "x" }, "t").verb).toBeNull();
});

test("Codex's web search, image view, dynamic tool and plan read like their Claude kin", () => {
	expect(said("webSearch", { query: "zod v4" })).toBe("Searched the web for zod v4");
	expect(toolLine("webSearch", { query: "q" }, "").icon).toBe("globe");
	const image = toolLine("imageView", { path: "/p/img/logo.png" }, "");
	expect([image.verb?.done, image.target, image.path, image.icon]).toEqual([
		"Viewed",
		"logo.png",
		"/p/img/logo.png",
		"file-image",
	]);
	expect(said("dynamicToolCall", { tool: "lookup", arguments: { id: 1 } })).toBe(
		"Used lookup",
	);
	expect(
		toolLine("dynamicToolCall", { tool: "lookup", arguments: { id: 1 } }, "").detail,
	).toEqual({ kind: "arguments", value: { id: 1 } });
	expect(
		toolLine("dynamicToolCall", { tool: "lookup", arguments: {} }, "").detail,
	).toBeNull();
	const plan = toolLine(
		"plan",
		{
			steps: [
				{ step: "Write a test", status: "completed" },
				{ step: "Fix it", status: "inProgress" },
				{ step: "Ship", status: "pending" },
			],
		},
		"",
	);
	expect([plan.verb?.done, plan.target, plan.icon]).toEqual([
		"Updated the plan",
		"1 of 3 steps done",
		"clipboard-list",
	]);
	expect(plan.detail).toEqual({
		kind: "text",
		text: "[x] Write a test\n[ ] Fix it\n[ ] Ship",
	});
	expect(toolLine("plan", { steps: [] }, "Plan").verb).toBeNull();
	expect(toolLine("plan", {}, "Plan").verb).toBeNull();
});

test("a Codex subagent tool is told in verbs like Claude's Agent rows", () => {
	const one = ["child-1"];
	const cases: [string, string[], string][] = [
		["spawnAgent", one, "Started a subagent"],
		["sendInput", one, "Sent input to a subagent"],
		["sendMessage", one, "Sent a message to a subagent"],
		["followupTask", one, "Sent a follow-up to a subagent"],
		["resumeAgent", one, "Resumed a subagent"],
		["wait", one, "Waited for a subagent"],
		["wait", ["a", "b"], "Waited for 2 subagents"],
		["closeAgent", one, "Closed a subagent"],
		["interruptAgent", one, "Interrupted a subagent"],
		["listAgents", [], "Listed subagents"],
		["spawnAgent", [], "Started a subagent"],
	];
	for (const [tool, receivers, text] of cases) {
		expect(said("collabAgentToolCall", { tool, receivers })).toBe(text);
	}
	expect(
		toolLine("collabAgentToolCall", { tool: "spawnAgent", receivers: one }, "").icon,
	).toBe("agent");
	// A tool this does not know is a plain row with its name.
	expect(toolLine("collabAgentToolCall", { tool: "teleport" }, "t")).toMatchObject({
		verb: null,
	});
	expect(collabReceivers({ receivers: ["a", 3, "", "b"] })).toEqual(["a", "b"]);
	expect(collabReceivers(null)).toEqual([]);
});

test('both agents\' MCP calls read "Used tool \u00b7 server" with their arguments', () => {
	const claude = toolLine("mcp__github__create_issue", { title: "Bug" }, "");
	expect([claude.verb?.done, claude.target, claude.icon, claude.detail]).toEqual([
		"Used",
		"create_issue \u00b7 github",
		"layers",
		{ kind: "arguments", value: { title: "Bug" } },
	]);
	const codex = toolLine(
		"mcpToolCall",
		{ server: "github", tool: "create_issue", arguments: { title: "Bug" } },
		"",
	);
	expect([codex.verb?.done, codex.target, codex.detail]).toEqual([
		claude.verb?.done,
		claude.target,
		claude.detail,
	]);
	// A tool name may hold double underscores; the server is what comes first.
	expect(mcpCall("mcp__srv__a__b", {})).toEqual({
		server: "srv",
		tool: "a__b",
		arguments: {},
	});
	expect(mcpCall("mcp__srv", {})).toBeNull();
	expect(mcpCall("mcp____tool", {})).toBeNull();
	expect(mcpCall("mcp__srv__", {})).toBeNull();
	expect(mcpCall("mcpToolCall", { server: "s" })).toBeNull();
	expect(mcpCall("mcpToolCall", null)).toBeNull();
	// No arguments, no detail.
	expect(toolLine("mcpToolCall", { server: "s", tool: "t" }, "").detail).toBeNull();
	expect(toolLine("mcp__s__t", {}, "").detail).toBeNull();
	expect(toolLine("mcpToolCall", { server: "s" }, "title")).toMatchObject({
		verb: null,
		target: "title",
	});
});

test('Claude\'s Skill call reads "Used skill name"', () => {
	const line = toolLine("Skill", { skill: "pdf", args: "a.pdf" }, "");
	expect([line.verb?.done, line.verb?.doing, line.target]).toEqual([
		"Used skill",
		"Using skill",
		"pdf",
	]);
	expect(toolLine("Skill", {}, "Skill").verb).toBeNull();
});

test("a tool nobody knows is a plain row with its own name", () => {
	expect(toolLine("reasoning", {}, "")).toMatchObject({ verb: null, icon: "box" });
	expect(toolLine("contextCompaction", null, "")).toMatchObject({ verb: null });
});

test("a group of calls names Codex's tools as a student reads them", () => {
	expect(toolLabel("commandExecution", {})).toBe("Bash");
	expect(toolLabel("fileChange", {})).toBe("File change");
	expect(toolLabel("mcpToolCall", { server: "s", tool: "t" })).toBe("t");
	expect(toolLabel("mcp__s__t2", {})).toBe("t2");
	expect(toolLabel("Read", {})).toBe("Read");
	expect(toolLabel("somethingNew", {})).toBe("somethingNew");
});

test("a plan decision is told for either agent's plan call", () => {
	expect(isPlanCall("ExitPlanMode")).toBe(true);
	expect(isPlanCall("plan")).toBe(true);
	expect(isPlanCall("Bash")).toBe(false);
});
