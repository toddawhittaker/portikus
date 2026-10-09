import { expect, test, vi } from "vitest";
import { type InsertTarget, insertText } from "./insertText";

function fakeEditor(selection: unknown) {
	const calls: string[] = [];
	const editor = {
		getSelection: () => selection,
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

const selection = {
	startLineNumber: 1,
	startColumn: 3,
	endLineNumber: 1,
	endColumn: 7,
};

test("the phrase replaces the selection in one edit between two undo stops", () => {
	const { editor, calls, target } = fakeEditor(selection);
	insertText(target, "hello");
	expect(editor.executeEdits).toHaveBeenCalledWith("voice", [
		{ range: selection, text: "hello", forceMoveMarkers: true },
	]);
	expect(calls).toEqual(["stop", "edit", "stop", "focus"]);
});

test("empty text or no cursor changes nothing", () => {
	const empty = fakeEditor(selection);
	insertText(empty.target, "");
	const none = fakeEditor(null);
	insertText(none.target, "hi");
	expect(empty.calls).toEqual([]);
	expect(none.calls).toEqual([]);
});
