import { expect, test } from "vitest";
import { INTELLIJ } from "./intellij.js";

/**
 * Colours pinned to the values JetBrains publishes in intellij-community
 * (commit a16c071c): themes/Light.xml with the Default scheme for IntelliJ Light,
 * and the Darcula scheme of DefaultColorSchemesManager.xml, both in
 * platform/platform-resources/src. The scheme is copied as published and never
 * adjusted.
 */
test("IntelliJ Light keeps its published colours", () => {
	const { tokens, colors } = INTELLIJ.light;
	expect(tokens.keyword).toBe("0033b3"); // DEFAULT_KEYWORD
	expect(tokens.string).toBe("067d17"); // DEFAULT_STRING
	expect(tokens.comment).toBe("8c8c8c"); // DEFAULT_LINE_COMMENT
	expect(tokens.number).toBe("1750eb"); // DEFAULT_NUMBER
	expect(tokens.constant).toBe("871094"); // DEFAULT_CONSTANT
	expect(tokens.annotation).toBe("9e880d"); // DEFAULT_METADATA
	expect(colors["editor.background"]).toBe("#ffffff"); // TEXT background
	// Light.xml writes the text colour as "80808", the number 0x080808.
	expect(colors["editor.foreground"]).toBe("#080808");
	expect(colors["editor.lineHighlightBackground"]).toBe("#fcfaed"); // CARET_ROW_COLOR
	expect(colors["editor.selectionBackground"]).toBe("#a6d2ff"); // SELECTION_BACKGROUND
	expect(colors["editorLineNumber.foreground"]).toBe("#adadad"); // LINE_NUMBERS_COLOR
});

test("IntelliJ Light sets comments and constants in italic, as FONT_TYPE 2 says", () => {
	expect(INTELLIJ.light.fontStyles?.comment).toBe("italic");
	expect(INTELLIJ.light.fontStyles?.["comment.doc"]).toBe("italic");
	expect(INTELLIJ.light.fontStyles?.constant).toBe("italic");
	expect(INTELLIJ.light.fontStyles?.keyword).toBeUndefined();
});

test("Darcula keeps its published colours", () => {
	const { tokens, colors } = INTELLIJ.dark;
	expect(tokens.keyword).toBe("cc7832");
	expect(tokens.string).toBe("6a8759");
	expect(tokens.comment).toBe("808080");
	expect(tokens["comment.doc"]).toBe("629755");
	expect(tokens.number).toBe("6897bb");
	expect(tokens.annotation).toBe("bbb529");
	expect(colors["editor.background"]).toBe("#2b2b2b");
	expect(colors["editor.foreground"]).toBe("#a9b7c6");
	expect(colors["editor.lineHighlightBackground"]).toBe("#323232");
	expect(colors["editor.selectionBackground"]).toBe("#214283");
	expect(colors["editorLineNumber.foreground"]).toBe("#606366");
});

test("Darcula italicises doc comments and constants but not line comments", () => {
	expect(INTELLIJ.dark.fontStyles?.comment).toBeUndefined();
	expect(INTELLIJ.dark.fontStyles?.["comment.doc"]).toBe("italic");
	expect(INTELLIJ.dark.fontStyles?.constant).toBe("italic");
});

/**
 * A token id with no attribute, or one whose attribute sets no colour, takes the
 * scheme's own default foreground, which is what IntelliJ draws for that text.
 */
test("a token the scheme sets no colour for takes the default foreground", () => {
	expect(INTELLIJ.light.tokens["operator.sql"]).toBe("080808");
	expect(INTELLIJ.light.tokens.invalid).toBe("080808");
	expect(INTELLIJ.dark.tokens["operator.sql"]).toBe("a9b7c6");
	expect(INTELLIJ.dark.tokens.invalid).toBe("a9b7c6");
});

test("a tag takes the keyword colour in Light, where IntelliJ sets no tag colour", () => {
	expect(INTELLIJ.light.tokens.tag).toBe(INTELLIJ.light.tokens.keyword);
	expect(INTELLIJ.dark.tokens.tag).toBe("e8bf6a"); // HTML_TAG_NAME
});

/** The source defines none of these, so Monaco's base theme supplies them. */
test("a colour the source does not define is left out", () => {
	for (const mode of [INTELLIJ.light, INTELLIJ.dark]) {
		expect(mode.colors["editorWidget.background"]).toBeUndefined();
		expect(mode.colors["textLink.foreground"]).toBeUndefined();
	}
	expect(INTELLIJ.light.colors["editorLineNumber.activeForeground"]).toBeUndefined();
});
