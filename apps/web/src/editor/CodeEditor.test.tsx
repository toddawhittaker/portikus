import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

// Monaco never loads here; the hold-to-talk keys are caught on the tab around it.
vi.mock("./monaco.js", () => ({
	accessibilitySupport: () => "auto",
	baseEditorOptions: {},
	currentThemeName: () => "light",
	editorAriaLabel: () => "Editor",
	getMonaco: () => new Promise(() => {}),
	languageForFile: () => "plaintext",
	watchTheme: () => {},
}));
vi.mock("./settingsQueries.js", () => ({ useScreenReaderMode: () => false }));
vi.mock("../layout/store.js", () => ({ useEditorZoom: () => [100, () => {}] }));

const { CodeEditor } = await import("./CodeEditor");

afterEach(cleanup);

function renderEditor(onVoiceHold?: (held: boolean) => void) {
	render(
		<CodeEditor
			path="a.txt"
			projectId="p1"
			value=""
			version="1"
			onChange={() => {}}
			onSave={() => {}}
			onVoiceHold={onVoiceHold}
		/>,
	);
	return screen
		.getByTestId("editor-a.txt")
		.querySelector(".pk-editor-host") as HTMLElement;
}

const shortcut = { code: "KeyM", key: "M", altKey: true, shiftKey: true };

test("Alt+Shift+M held in the editor listens once until a key is released", () => {
	const hold = vi.fn();
	const host = renderEditor(hold);
	fireEvent.keyDown(host, shortcut);
	fireEvent.keyDown(host, { ...shortcut, repeat: true });
	expect(hold.mock.calls).toEqual([[true]]);
	fireEvent.keyUp(host, { code: "ShiftLeft", key: "Shift", altKey: true });
	expect(hold.mock.calls).toEqual([[true], [false]]);
});

test("the shortcut keydown is taken from Monaco", () => {
	const host = renderEditor(vi.fn());
	const typed = fireEvent.keyDown(host, shortcut);
	expect(typed).toBe(false);
});

test("leaving the editor while held stops listening", () => {
	const hold = vi.fn();
	const host = renderEditor(hold);
	fireEvent.keyDown(host, shortcut);
	fireEvent.focusOut(host);
	expect(hold.mock.calls).toEqual([[true], [false]]);
});

test("without voice the shortcut is left alone", () => {
	const host = renderEditor();
	expect(fireEvent.keyDown(host, shortcut)).toBe(true);
});
