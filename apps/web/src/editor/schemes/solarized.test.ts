import { expect, test } from "vitest";
import { SOLARIZED } from "./solarized.js";

/**
 * Colours pinned to the values microsoft/vscode publishes in
 * extensions/theme-solarized-light and theme-solarized-dark (commit 580745c3), so an
 * edit to a colour has to be deliberate. The scheme is copied as published and never
 * adjusted.
 */
test("Solarized Light keeps its published colours", () => {
	const { tokens, colors } = SOLARIZED.light;
	expect(tokens.keyword).toBe("859900");
	expect(tokens.string).toBe("2AA198");
	expect(tokens.comment).toBe("93A1A1");
	expect(tokens.number).toBe("D33682");
	expect(tokens.type).toBe("CB4B16");
	expect(tokens.identifier).toBe("657B83");
	expect(colors["editor.background"]).toBe("#FDF6E3");
	expect(colors["editor.foreground"]).toBe("#657B83");
	expect(colors["editorLineNumber.foreground"]).toBeUndefined();
	expect(colors["editor.lineHighlightBackground"]).toBe("#EEE8D5");
});

test("Solarized Light: the source italicises comments, so comments are italic", () => {
	expect(SOLARIZED.light.fontStyles?.comment).toBe("italic");
});

test("Solarized Dark keeps its published colours", () => {
	const { tokens, colors } = SOLARIZED.dark;
	expect(tokens.keyword).toBe("859900");
	expect(tokens.string).toBe("2AA198");
	expect(tokens.comment).toBe("586E75");
	expect(tokens.number).toBe("D33682");
	expect(tokens.type).toBe("CB4B16");
	expect(tokens.identifier).toBe("839496");
	expect(colors["editor.background"]).toBe("#002B36");
	expect(colors["editor.foreground"]).toBe("#839496");
	expect(colors["editorLineNumber.foreground"]).toBeUndefined();
	expect(colors["editor.lineHighlightBackground"]).toBe("#073642");
});

test("Solarized Dark: the source italicises comments, so comments are italic", () => {
	expect(SOLARIZED.dark.fontStyles?.comment).toBe("italic");
});
