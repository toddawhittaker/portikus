import { expect, test } from "vitest";
import { type ClipboardKeyEvent, decide } from "./terminalClipboard";

function key(partial: Partial<ClipboardKeyEvent>): ClipboardKeyEvent {
	return {
		type: "keydown",
		key: "a",
		ctrlKey: false,
		shiftKey: false,
		altKey: false,
		metaKey: false,
		...partial,
	};
}

test.each([
	["Ctrl+Shift+C copies", { ctrlKey: true, shiftKey: true, key: "C" }, true, "copy"],
	[
		"Ctrl+Shift+C copies with nothing selected",
		{ ctrlKey: true, shiftKey: true, key: "C" },
		false,
		"copy",
	],
	["Ctrl+Shift+V pastes", { ctrlKey: true, shiftKey: true, key: "V" }, false, "paste"],
	["Ctrl+V pastes", { ctrlKey: true, key: "v" }, false, "paste"],
	["Ctrl+C with a selection copies", { ctrlKey: true, key: "c" }, true, "copy"],
	[
		"Ctrl+C with no selection reaches the shell",
		{ ctrlKey: true, key: "c" },
		false,
		"passthrough",
	],
	["Ctrl+D reaches the shell", { ctrlKey: true, key: "d" }, true, "passthrough"],
	["a plain letter reaches the shell", { key: "c" }, true, "passthrough"],
	["Shift+C reaches the shell", { shiftKey: true, key: "C" }, true, "passthrough"],
	[
		"Alt+C reaches the shell",
		{ altKey: true, ctrlKey: true, key: "c" },
		true,
		"passthrough",
	],
	[
		"Meta+C is not the clipboard off macOS",
		{ metaKey: true, key: "c" },
		true,
		"passthrough",
	],
	[
		"Meta+V is not the clipboard off macOS",
		{ metaKey: true, key: "v" },
		false,
		"passthrough",
	],
])("%s", (_name, event, hasSelection, expected) => {
	expect(decide(key(event), hasSelection)).toBe(expected);
});

test.each([
	["Command+C with a selection copies", { metaKey: true, key: "c" }, true, "copy"],
	[
		"Command+C with no selection reaches the shell",
		{ metaKey: true, key: "c" },
		false,
		"passthrough",
	],
	["Command+V pastes", { metaKey: true, key: "v" }, false, "paste"],
	[
		"Command+Shift+C copies",
		{ metaKey: true, shiftKey: true, key: "C" },
		false,
		"copy",
	],
	["Ctrl+C still interrupts", { ctrlKey: true, key: "c" }, false, "passthrough"],
])("on macOS, %s", (_name, event, hasSelection, expected) => {
	expect(decide(key(event), hasSelection, "mac")).toBe(expected);
});

test("key releases are never clipboard actions", () => {
	expect(decide(key({ type: "keyup", ctrlKey: true, key: "c" }), true)).toBe(
		"passthrough",
	);
});
