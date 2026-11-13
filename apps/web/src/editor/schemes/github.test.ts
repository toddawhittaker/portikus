import { expect, test } from "vitest";
import { GITHUB } from "./github.js";

/**
 * Colours pinned to the values the published github-vscode-theme 6.3.5 holds in
 * themes/light-default.json and themes/dark-default.json, so an edit to a colour has
 * to be deliberate. The scheme is copied as published and never adjusted.
 */
test("GitHub Light Default keeps its published colours", () => {
	const { tokens, colors } = GITHUB.light;
	expect(tokens.keyword).toBe("cf222e");
	expect(tokens.string).toBe("0a3069");
	expect(tokens.comment).toBe("6e7781");
	expect(tokens.number).toBe("0550ae");
	expect(tokens.type).toBe("953800");
	expect(tokens.identifier).toBe("953800");
	expect(colors["editor.background"]).toBe("#ffffff");
	expect(colors["editor.foreground"]).toBe("#1f2328");
	expect(colors["editorLineNumber.foreground"]).toBe("#8c959f");
});

test("GitHub Light Default: the source does not style comments, so comments have no font style", () => {
	expect(GITHUB.light.fontStyles?.comment).toBeUndefined();
});

test("GitHub Dark Default keeps its published colours", () => {
	const { tokens, colors } = GITHUB.dark;
	expect(tokens.keyword).toBe("ff7b72");
	expect(tokens.string).toBe("a5d6ff");
	expect(tokens.comment).toBe("8b949e");
	expect(tokens.number).toBe("79c0ff");
	expect(tokens.type).toBe("ffa657");
	expect(tokens.identifier).toBe("ffa657");
	expect(colors["editor.background"]).toBe("#0d1117");
	expect(colors["editor.foreground"]).toBe("#e6edf3");
	expect(colors["editorLineNumber.foreground"]).toBe("#6e7681");
});

test("GitHub Dark Default: the source does not style comments, so comments have no font style", () => {
	expect(GITHUB.dark.fontStyles?.comment).toBeUndefined();
});
