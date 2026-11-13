import { expect, test } from "vitest";
import { CATPPUCCIN } from "./catppuccin.js";

/**
 * Colours pinned to the values the published catppuccin-vsc 3.19.0 holds in
 * themes/latte.json and themes/mocha.json, so an edit to a colour has to be deliberate.
 * The scheme is copied as published and never adjusted.
 */
test("Catppuccin Latte keeps its published colours", () => {
	const { tokens, colors } = CATPPUCCIN.light;
	expect(tokens.keyword).toBe("8839ef");
	expect(tokens.string).toBe("40a02b");
	expect(tokens.comment).toBe("7c7f93");
	expect(tokens.number).toBe("fe640b");
	expect(tokens.type).toBe("df8e1d");
	expect(tokens.identifier).toBe("4c4f69");
	expect(colors["editor.background"]).toBe("#eff1f5");
	expect(colors["editor.foreground"]).toBe("#4c4f69");
	expect(colors["editorLineNumber.foreground"]).toBe("#8c8fa1");
});

test("Catppuccin Latte: the source italicises comments, so comments are italic", () => {
	expect(CATPPUCCIN.light.fontStyles?.comment).toBe("italic");
});

test("Catppuccin Mocha keeps its published colours", () => {
	const { tokens, colors } = CATPPUCCIN.dark;
	expect(tokens.keyword).toBe("cba6f7");
	expect(tokens.string).toBe("a6e3a1");
	expect(tokens.comment).toBe("9399b2");
	expect(tokens.number).toBe("fab387");
	expect(tokens.type).toBe("f9e2af");
	expect(tokens.identifier).toBe("cdd6f4");
	expect(colors["editor.background"]).toBe("#1e1e2e");
	expect(colors["editor.foreground"]).toBe("#cdd6f4");
	expect(colors["editorLineNumber.foreground"]).toBe("#7f849c");
});

test("Catppuccin Mocha: the source italicises comments, so comments are italic", () => {
	expect(CATPPUCCIN.dark.fontStyles?.comment).toBe("italic");
});
