import { expect, test } from "vitest";
import type { ChatItem } from "./chatStore.js";
import {
	type Browsing,
	plainDoc,
	type Step,
	sentHistory,
	stepHistory,
} from "./composerHistory.js";

function message(role: "user" | "assistant", markdown: string, at = 0): ChatItem {
	return {
		kind: "message",
		key: `message:${role}${at}`,
		id: `${role}${at}`,
		role,
		markdown,
		attachments: [],
		streaming: false,
		turnId: null,
	};
}

function shell(command: string): ChatItem {
	return {
		kind: "shell",
		key: `shell:${command}`,
		turnId: null,
		id: command,
		command,
		output: "",
		exitCode: 0,
		truncated: false,
		state: "done",
	};
}

const draft = { type: "doc", content: [{ type: "paragraph" }] };

test("the history is the student's own messages, oldest first", () => {
	const items = [
		message("user", "first", 1),
		message("assistant", "reply", 2),
		message("user", "second", 3),
	];
	expect(sentHistory(items, null)).toEqual(["first", "second"]);
});

test("a shell command is history as the student typed it, with its bang", () => {
	const items = [
		message("user", "first", 1),
		shell("ls -la"),
		message("user", "next", 2),
	];
	expect(sentHistory(items, null)).toEqual(["first", "!ls -la", "next"]);
});

test("a blank message and a tool call are not history", () => {
	expect(sentHistory([message("user", "  \n", 1)], null)).toEqual([]);
});

test("a message not yet echoed is the newest entry, and not twice once it is", () => {
	const items = [message("user", "first", 1)];
	expect(sentHistory(items, "second")).toEqual(["first", "second"]);
	expect(sentHistory([...items, message("user", "second", 2)], "second")).toEqual([
		"first",
		"second",
	]);
	expect(sentHistory(items, "  ")).toEqual(["first"]);
});

test("a plain document has a paragraph for each line, and an empty one for a blank line", () => {
	expect(plainDoc("a\n\nb")).toEqual({
		type: "doc",
		content: [
			{ type: "paragraph", content: [{ type: "text", text: "a" }] },
			{ type: "paragraph" },
			{ type: "paragraph", content: [{ type: "text", text: "b" }] },
		],
	});
});

const history = ["one", "two", "three"];
const here = (text: string) => ({ text, json: draft });

function step(
	browsing: Browsing | null,
	direction: "up" | "down",
	text = "",
): Step | null {
	return stepHistory(browsing, direction, history, here(text));
}

test("Up with nothing sent, or Down when not browsing, is left to the box", () => {
	expect(stepHistory(null, "up", [], here("x"))).toBeNull();
	expect(step(null, "down")).toBeNull();
});

test("Up starts at the newest message and keeps the draft", () => {
	const first = step(null, "up", "half typed");
	expect(first?.show).toEqual({ text: "three" });
	expect(first?.browsing).toEqual({ index: 2, draft, shown: "three" });
});

test("Up walks back to the oldest and stays there", () => {
	let now = step(null, "up");
	now = step(now?.browsing ?? null, "up", "three");
	expect(now?.show).toEqual({ text: "two" });
	now = step(now?.browsing ?? null, "up", "two");
	expect(now?.show).toEqual({ text: "one" });
	const stay = step(now?.browsing ?? null, "up", "one");
	expect(stay?.show).toBeNull();
	expect(stay?.browsing?.index).toBe(0);
});

test("Down walks forward, then past the newest restores the draft", () => {
	const browsing: Browsing = { index: 0, draft, shown: "one" };
	const next = step(browsing, "down", "one");
	expect(next?.show).toEqual({ text: "two" });
	const last = step({ index: 2, draft, shown: "three" }, "down", "three");
	expect(last?.show).toEqual({ draft });
	expect(last?.browsing).toBeNull();
});

test("an edit ends browsing: the edited text is the draft and Up starts at the newest", () => {
	const edited: Browsing = { index: 0, draft: { type: "doc" }, shown: "one" };
	const up = step(edited, "up", "one!");
	expect(up?.show).toEqual({ text: "three" });
	expect(up?.browsing?.draft).toBe(draft);
	// Down after an edit has nowhere to go, so the box keeps it.
	expect(step(edited, "down", "one!")).toBeNull();
});

test("a history that shrank under the student does not leave Down stranded", () => {
	const gone: Browsing = { index: 5, draft, shown: "x" };
	expect(stepHistory(gone, "down", [], here("x"))?.show).toEqual({ draft });
	const stay = stepHistory(gone, "up", ["only"], here("x"));
	expect(stay?.show).toBeNull();
	expect(stay?.browsing?.index).toBe(0);
});
