import { expect, test } from "vitest";
import { HIGH_CONTRAST } from "./high-contrast.js";

/**
 * Colours pinned to the values microsoft/vscode publishes in
 * extensions/theme-defaults/themes/hc_light.json and hc_black.json (commit 580745c3),
 * so an edit to a colour has to be deliberate. The scheme is copied as published and
 * never adjusted.
 */
test("High Contrast Light keeps its published colours", () => {
	const { tokens, colors } = HIGH_CONTRAST.light;
	expect(tokens.keyword).toBe("0F4A85");
	expect(tokens.string).toBe("0F4A85");
	expect(tokens.comment).toBe("515151");
	expect(tokens.number).toBe("096d48");
	expect(tokens.type).toBe("185E73");
	expect(tokens.identifier).toBe("001080");
	expect(colors["editor.background"]).toBeUndefined();
	expect(colors["editor.foreground"]).toBeUndefined();
	expect(colors["editorLineNumber.foreground"]).toBeUndefined();
});

test("High Contrast Light: the source does not style comments, so comments have no font style", () => {
	expect(HIGH_CONTRAST.light.fontStyles?.comment).toBeUndefined();
});

test("High Contrast Dark keeps its published colours", () => {
	const { tokens, colors } = HIGH_CONTRAST.dark;
	expect(tokens.keyword).toBe("569cd6");
	expect(tokens.string).toBe("ce9178");
	expect(tokens.comment).toBe("7ca668");
	expect(tokens.number).toBe("b5cea8");
	expect(tokens.type).toBe("4EC9B0");
	expect(tokens.identifier).toBe("9CDCFE");
	expect(colors["editor.background"]).toBe("#000000");
	expect(colors["editor.foreground"]).toBe("#FFFFFF");
	expect(colors["editorLineNumber.foreground"]).toBeUndefined();
});

test("High Contrast Dark: the source does not style comments, so comments have no font style", () => {
	expect(HIGH_CONTRAST.dark.fontStyles?.comment).toBeUndefined();
});
