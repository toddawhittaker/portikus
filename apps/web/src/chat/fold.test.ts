import { expect, test } from "vitest";
import type { ChatItem, ChatMessageItem, ChatToolItem } from "./chatStore";
import { formatElapsed, isoDuration } from "./elapsed";
import { foldTurn } from "./fold";

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

test("a turn's length reads as minutes and seconds", () => {
	expect(formatElapsed(12_400)).toBe("0m 12s");
	expect(formatElapsed(223_000)).toBe("3m 43s");
	expect(formatElapsed(3_900_000)).toBe("1h 5m");
	expect(formatElapsed(-5)).toBe("0m 0s");
	expect(isoDuration(223_000)).toBe("PT223S");
});
