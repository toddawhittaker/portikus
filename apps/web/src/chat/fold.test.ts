import { expect, test } from "vitest";
import type { ChatItem, ChatMessageItem, ChatToolItem } from "./chatStore";
import { formatElapsed, isoDuration } from "./elapsed";
import { changedFiles, foldTurn, groupTools } from "./fold";

function said(id: string): ChatMessageItem {
	return {
		kind: "message",
		key: `message:${id}`,
		id,
		role: "assistant",
		markdown: id,
		attachments: [],
		streaming: false,
		turnId: "t",
	};
}

function tool(id: string): ChatToolItem {
	return {
		kind: "tool",
		key: `tool:${id}`,
		id,
		name: "Bash",
		title: "",
		input: {},
		output: [],
		status: "done",
		turnId: "t",
	};
}

const keys = (items: readonly (ChatItem | null)[]) =>
	items.map((item) => item?.key ?? null);

test("the first and final messages stay out; the work and narration between fold", () => {
	const first = said("first");
	const final = said("final");
	const folded = foldTurn([first, tool("1"), said("middle"), tool("2"), final]);
	expect(folded.before).toBe(first);
	expect(folded.after).toBe(final);
	expect(keys(folded.folded)).toEqual(["tool:1", "message:middle", "tool:2"]);
});

test("one message after the work is shown after the fold", () => {
	const only = said("only");
	const folded = foldTurn([tool("1"), only]);
	expect(folded.before).toBeNull();
	expect(folded.after).toBe(only);
	expect(keys(folded.folded)).toEqual(["tool:1"]);
});

test("one message before the work is shown before the fold", () => {
	const only = said("only");
	const folded = foldTurn([only, tool("1")]);
	expect(folded.before).toBe(only);
	expect(folded.after).toBeNull();
});

test("a turn with only tools folds all of them, and errors stay visible", () => {
	const error: ChatItem = { kind: "error", key: "error:1", message: "x", turnId: "t" };
	const folded = foldTurn([tool("1"), error, tool("2")]);
	expect(folded.before).toBeNull();
	expect(folded.after).toBeNull();
	expect(keys(folded.folded)).toEqual(["tool:1", "tool:2"]);
	expect(folded.errors).toEqual([error]);
});

const never = () => false;

test("consecutive tool calls gather into one run, keyed by the first", () => {
	const shown = groupTools(
		[said("a"), tool("1"), tool("2"), tool("3"), said("b")],
		never,
	);
	expect(shown.map((one) => one.key)).toEqual(["message:a", "run:tool:1", "message:b"]);
	const run = shown[1];
	expect(run?.kind === "tools" ? keys(run.tools) : null).toEqual([
		"tool:1",
		"tool:2",
		"tool:3",
	]);
});

test("text between calls splits them into separate runs, and a lone call stays a row", () => {
	const shown = groupTools([tool("1"), tool("2"), said("m"), tool("3")], never);
	expect(shown.map((one) => one.key)).toEqual(["run:tool:1", "message:m", "tool:3"]);
	expect(shown[2]?.kind).toBe("tool");
});

test("a call that stands alone, and an error, break a run", () => {
	const error: ChatItem = { kind: "error", key: "error:1", message: "x", turnId: "t" };
	const shown = groupTools(
		[tool("1"), tool("ask"), tool("2"), tool("3"), error, tool("4"), tool("5")],
		(one) => one.id === "ask",
	);
	expect(shown.map((one) => one.key)).toEqual([
		"tool:1",
		"tool:ask",
		"run:tool:2",
		"error:1",
		"run:tool:4",
	]);
});

test("a growing run keeps its key, so it stays in place", () => {
	const two = groupTools([tool("1"), tool("2")], never);
	const three = groupTools([tool("1"), tool("2"), tool("3")], never);
	expect(two[0]?.key).toBe(three[0]?.key);
	expect(groupTools([], never)).toEqual([]);
});

test("a turn's length reads as minutes and seconds", () => {
	expect(formatElapsed(12_400)).toBe("0m 12s");
	expect(formatElapsed(223_000)).toBe("3m 43s");
	expect(formatElapsed(3_900_000)).toBe("1h 5m");
	expect(formatElapsed(-5)).toBe("0m 0s");
	expect(isoDuration(223_000)).toBe("PT223S");
});

function call(
	name: string,
	input: unknown,
	status: ChatToolItem["status"] = "done",
	id = `${name}-${JSON.stringify(input)}`,
): ChatToolItem {
	return {
		kind: "tool",
		key: id,
		id,
		name,
		title: name,
		input,
		output: [],
		status,
		turnId: "t1",
	};
}

test("a file edited twice is one entry with its counts summed, in first-touched order", () => {
	const files = changedFiles([
		call(
			"Edit",
			{ file_path: "/p/a.ts", old_string: "x", new_string: "y\nz" },
			"done",
			"1",
		),
		call("Write", { file_path: "/p/b.ts", content: "one\ntwo\nthree\n" }),
		call("MultiEdit", {
			file_path: "/p/a.ts",
			edits: [{ old_string: "q\nr", new_string: "s" }],
		}),
	]);
	expect(files).toEqual([
		{ path: "/p/a.ts", added: 3, removed: 3 },
		// A created file is all additions.
		{ path: "/p/b.ts", added: 3, removed: 0 },
	]);
});

test("the same file reached by a relative and an absolute path is one entry", () => {
	const edit = (file_path: string, id: string) =>
		call("Edit", { file_path, old_string: "x", new_string: "y" }, "done", id);
	expect(
		changedFiles(
			[
				edit("src/a.ts", "1"),
				edit("/home/student/projects/demo/src/a.ts", "2"),
				edit("./src/a.ts", "3"),
				edit("/home/student/projects/demo/../x.ts", "4"),
			],
			"demo",
		),
	).toEqual([
		{ path: "src/a.ts", added: 3, removed: 3 },
		// Outside the project it stays as Claude named it.
		{ path: "/home/student/projects/demo/../x.ts", added: 1, removed: 1 },
	]);
});

test("only finished edits count: failed, stopped and running ones changed nothing", () => {
	const edit = { file_path: "a.ts", old_string: "x", new_string: "y" };
	expect(
		changedFiles([
			call("Edit", edit, "error", "1"),
			call("Edit", edit, "stopped", "2"),
			call("Edit", edit, "running", "3"),
		]),
	).toEqual([]);
});

test("reads, commands and other items are not changes", () => {
	expect(
		changedFiles([
			said("hi"),
			call("Read", { file_path: "a.ts" }),
			call("Bash", { command: "rm a.ts" }),
			call("Edit", { old_string: "x", new_string: "y" }),
			call("Write", { file_path: "empty.ts", content: "" }),
		]),
	).toEqual([{ path: "empty.ts", added: 0, removed: 0 }]);
});

const change = (path: string, kind: string, diff: string, movePath?: string) => ({
	path,
	kind,
	diff,
	...(movePath ? { movePath } : {}),
});

test("a Codex file change counts each file it added, edited, moved and deleted", () => {
	expect(
		changedFiles(
			[
				call(
					"fileChange",
					{
						changes: [
							change(
								"/home/student/projects/demo/src/a.ts",
								"update",
								"@@ -1 +1,2 @@\n-x\n+y\n+z\n",
							),
							change("/home/student/projects/demo/new.md", "add", "# Hi\n\nthere\n"),
							change("/home/student/projects/demo/old.md", "delete", "a\nb\n"),
							change(
								"/home/student/projects/demo/b.ts",
								"update",
								"@@ -1 +1 @@\n-1\n+2\n",
								"/home/student/projects/demo/c.ts",
							),
						],
					},
					"done",
					"fc1",
				),
				// The same file again adds to its entry.
				call(
					"fileChange",
					{ changes: [change("src/a.ts", "update", "@@ -1 +1 @@\n-y\n+w\n")] },
					"done",
					"fc2",
				),
			],
			"demo",
		),
	).toEqual([
		{ path: "src/a.ts", added: 3, removed: 2 },
		{ path: "new.md", added: 3, removed: 0 },
		// A deleted file counts, with every line it had as removed.
		{ path: "old.md", added: 0, removed: 2 },
		// A moved file is under its new name.
		{ path: "c.ts", added: 1, removed: 1 },
	]);
});

test("a Codex file change that is unfinished or unreadable changes nothing", () => {
	const input = { changes: [change("a.ts", "add", "x\n")] };
	expect(
		changedFiles([
			call("fileChange", input, "error", "1"),
			call("fileChange", input, "running", "2"),
			call("fileChange", { changes: [] }, "done", "3"),
			call("fileChange", "nonsense", "done", "4"),
		]),
	).toEqual([]);
});
