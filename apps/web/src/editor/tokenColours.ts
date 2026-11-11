/**
 * Syntax colours drawn from the interface's own families: muted blue for
 * keywords, terracotta for strings, teal for numbers, purple for types and
 * decorators, and the faint ink for comments. Every one reads at 4.5:1 or
 * better on the editor and line-highlight backgrounds (SPEC.md section 25.8).
 */
const LIGHT = {
	blue: "36598f",
	terracotta: "9a4526",
	teal: "1f6b66",
	purple: "7b3f99",
	faint: "655f55",
	ink: "23211d",
	red: "a4342a",
};

const DARK = {
	blue: "9fb4e0",
	terracotta: "e8a383",
	teal: "7cc2b9",
	purple: "c9a3dc",
	faint: "9a9387",
	ink: "ece8df",
	red: "f0998f",
};

function tokens(c: typeof LIGHT): Record<string, string> {
	return {
		keyword: c.blue,
		"keyword.flow": c.blue,
		"keyword.control": c.blue,
		"variable.predefined": c.blue,
		string: c.terracotta,
		"string.escape": c.teal,
		"string.sql": c.terracotta,
		"string.key.json": c.blue,
		"string.value.json": c.terracotta,
		regexp: c.terracotta,
		comment: c.faint,
		"comment.doc": c.faint,
		number: c.teal,
		"number.hex": c.teal,
		constant: c.teal,
		type: c.purple,
		"type.identifier": c.purple,
		annotation: c.purple,
		tag: c.purple,
		"tag.id.pug": c.blue,
		"tag.class.pug": c.blue,
		metatag: c.purple,
		"metatag.content.html": c.terracotta,
		"metatag.html": c.faint,
		"metatag.xml": c.faint,
		"attribute.name": c.teal,
		"attribute.value": c.terracotta,
		"attribute.value.number": c.teal,
		"attribute.value.unit": c.teal,
		"delimiter.html": c.faint,
		"delimiter.xml": c.faint,
		"operator.sql": c.faint,
		"predefined.sql": c.purple,
		identifier: c.ink,
		invalid: c.red,
	};
}

export const LIGHT_TOKENS: Record<string, string> = tokens(LIGHT);

export const DARK_TOKENS: Record<string, string> = tokens(DARK);

/** Bracket pair colours, in the same three families, so nesting reads without a clash. */
export const LIGHT_BRACKETS: Record<string, string> = {
	"editorBracketHighlight.foreground1": LIGHT.blue,
	"editorBracketHighlight.foreground2": LIGHT.purple,
	"editorBracketHighlight.foreground3": LIGHT.teal,
	"editorBracketHighlight.unexpectedBracket.foreground": LIGHT.red,
};

export const DARK_BRACKETS: Record<string, string> = {
	"editorBracketHighlight.foreground1": DARK.blue,
	"editorBracketHighlight.foreground2": DARK.purple,
	"editorBracketHighlight.foreground3": DARK.teal,
	"editorBracketHighlight.unexpectedBracket.foreground": DARK.red,
};
