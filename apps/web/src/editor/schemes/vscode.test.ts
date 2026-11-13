import { expect, test } from "vitest";
import { VSCODE } from "./vscode.js";

/**
 * Colours pinned to the values microsoft/vscode publishes in
 * extensions/theme-defaults/themes (light_modern.json with light_plus.json and
 * light_vs.json, and the dark three), so an edit to a colour has to be
 * deliberate. The scheme is copied as published and never adjusted.
 */
test("Light Modern keeps its published colours", () => {
	const { tokens, colors } = VSCODE.light;
	expect(tokens.keyword).toBe("0000ff");
	expect(tokens["keyword.control"]).toBe("AF00DB");
	expect(tokens.string).toBe("a31515");
	expect(tokens.comment).toBe("008000");
	expect(tokens.number).toBe("098658");
	expect(tokens.type).toBe("267f99");
	expect(tokens.invalid).toBe("cd3131");
	expect(colors["editor.background"]).toBe("#FFFFFF");
	expect(colors["editor.foreground"]).toBe("#3B3B3B");
	expect(colors["editorLineNumber.foreground"]).toBe("#6E7681");
	expect(colors["editorWidget.background"]).toBe("#F8F8F8");
});

test("Dark Modern keeps its published colours", () => {
	const { tokens, colors } = VSCODE.dark;
	expect(tokens.keyword).toBe("569cd6");
	expect(tokens["keyword.control"]).toBe("C586C0");
	expect(tokens.string).toBe("ce9178");
	expect(tokens.comment).toBe("6A9955");
	expect(tokens.number).toBe("b5cea8");
	expect(tokens.type).toBe("4EC9B0");
	expect(tokens.invalid).toBe("f44747");
	expect(colors["editor.background"]).toBe("#1F1F1F");
	expect(colors["editor.foreground"]).toBe("#CCCCCC");
	expect(colors["editorLineNumber.foreground"]).toBe("#6E7681");
	expect(colors["editorWidget.background"]).toBe("#202020");
});

/** The source defines none of these, so Monaco's base theme supplies them. */
test("a colour the source does not define is left out", () => {
	for (const mode of [VSCODE.light, VSCODE.dark]) {
		expect(mode.colors["editor.lineHighlightBackground"]).toBeUndefined();
		expect(mode.colors["editor.selectionBackground"]).toBeUndefined();
		expect(mode.colors["editorCursor.foreground"]).toBeUndefined();
	}
});
