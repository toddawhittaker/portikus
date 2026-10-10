import { expect, test, vi } from "vitest";
import { type InsertTarget, insertText } from "./insertText";

function fakeEditor(selection: unknown, line = "") {
	const calls: string[] = [];
	const editor = {
		getSelection: () => selection,
		getModel: () => ({ getLineContent: () => line }),
		pushUndoStop: vi.fn(() => {
			calls.push("stop");
			return true;
		}),
		executeEdits: vi.fn(() => {
			calls.push("edit");
			return true;
		}),
		focus: vi.fn(() => calls.push("focus")),
	};
	return { editor, calls, target: editor as unknown as InsertTarget };
}

function at(startColumn: number, endColumn = startColumn) {
	return { startLineNumber: 1, startColumn, endLineNumber: 1, endColumn };
}

function typed(target: ReturnType<typeof fakeEditor>) {
	return (target.editor.executeEdits.mock.calls[0] as unknown[] | undefined)?.[1];
}

test("the phrase replaces the selection in one edit between two undo stops, without moving focus", () => {
	const fake = fakeEditor(at(3, 7), "a hello");
	insertText(fake.target, "hello");
	expect(typed(fake)).toEqual([
		{ range: at(3, 7), text: "hello", forceMoveMarkers: true },
	]);
	// Focusing the editor would blur the held mic button and stop listening.
	expect(fake.calls).toEqual(["stop", "edit", "stop"]);
});

test("a phrase after a word gets one leading space", () => {
	const fake = fakeEditor(at(6), "hello");
	insertText(fake.target, "world");
	expect(typed(fake)).toEqual([
		{ range: at(6), text: " world", forceMoveMarkers: true },
	]);
});

test("no leading space at line start or after whitespace", () => {
	const start = fakeEditor(at(1), "x");
	insertText(start.target, "one");
	const afterSpace = fakeEditor(at(4), "ab cd");
	insertText(afterSpace.target, "two");
	const afterTab = fakeEditor(at(2), "\tx");
	insertText(afterTab.target, "three");
	const ownSpace = fakeEditor(at(6), "hello");
	insertText(ownSpace.target, " four");
	expect(typed(ownSpace)).toEqual([
		{ range: at(6), text: " four", forceMoveMarkers: true },
	]);
	expect(typed(start)).toEqual([{ range: at(1), text: "one", forceMoveMarkers: true }]);
	expect(typed(afterSpace)).toEqual([
		{ range: at(4), text: "two", forceMoveMarkers: true },
	]);
	expect(typed(afterTab)).toEqual([
		{ range: at(2), text: "three", forceMoveMarkers: true },
	]);
});

test("empty text or no cursor changes nothing", () => {
	const empty = fakeEditor(at(3, 7));
	insertText(empty.target, "");
	const none = fakeEditor(null);
	insertText(none.target, "hi");
	expect(empty.calls).toEqual([]);
	expect(none.calls).toEqual([]);
});
