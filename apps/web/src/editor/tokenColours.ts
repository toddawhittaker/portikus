/**
 * The editor's ground and its current-line highlight in each theme: the
 * --surface-work and --surface tokens of packages/ui/src/theme.css.
 */
export const EDITOR_BACKGROUNDS = {
	light: { ground: "fffdf8", line: "f5f1e8" },
	dark: { ground: "171614", line: "1f1e1b" },
} as const;

/**
 * Syntax colours from warm hues, distinct from one another: terracotta
 * keywords and tags, sage strings, teal numbers and constants, amber types
 * and attributes, blue SQL built-ins, and the faint ink for comments. Violet
 * stays out, as it means a coding agent (DESIGN.md section 11). Every one
 * reads at 4.5:1 or better on the editor and line-highlight backgrounds
 * (SPEC.md section 25.8).
 */
const LIGHT = {
	sage: "466620",
	teal: "0e6b62",
	terracotta: "b23a1e",
	amber: "8a5300",
	blue: "2f58a8",
	faint: "675f53",
	ink: "221f1a",
	red: "b0372b",
};

const DARK = {
	sage: "b5c97e",
	teal: "5fd0bf",
	terracotta: "f4957c",
	amber: "f0c062",
	blue: "93b6f2",
	faint: "aaa396",
	ink: "f0ebe1",
	red: "f59a8e",
};

function tokens(c: typeof LIGHT): Record<string, string> {
	return {
		keyword: c.terracotta,
		"keyword.flow": c.terracotta,
		"keyword.control": c.terracotta,
		"variable.predefined": c.teal,
		string: c.sage,
		"string.escape": c.teal,
		"string.sql": c.sage,
		"string.key.json": c.amber,
		"string.value.json": c.sage,
		regexp: c.teal,
		comment: c.faint,
		"comment.doc": c.faint,
		number: c.teal,
		"number.hex": c.teal,
		constant: c.teal,
		type: c.amber,
		"type.identifier": c.amber,
		annotation: c.amber,
		tag: c.terracotta,
		"tag.id.pug": c.amber,
		"tag.class.pug": c.amber,
		metatag: c.terracotta,
		"metatag.content.html": c.sage,
		"metatag.html": c.faint,
		"metatag.xml": c.faint,
		"attribute.name": c.amber,
		"attribute.value": c.sage,
		"attribute.value.number": c.teal,
		"attribute.value.unit": c.teal,
		"delimiter.html": c.faint,
		"delimiter.xml": c.faint,
		"operator.sql": c.faint,
		"predefined.sql": c.blue,
		identifier: c.ink,
		invalid: c.red,
	};
}

export const LIGHT_TOKENS: Record<string, string> = tokens(LIGHT);

export const DARK_TOKENS: Record<string, string> = tokens(DARK);

/** Bracket pair colours, in three of the same families, so nesting reads without a clash. */
export const LIGHT_BRACKETS: Record<string, string> = {
	"editorBracketHighlight.foreground1": LIGHT.amber,
	"editorBracketHighlight.foreground2": LIGHT.sage,
	"editorBracketHighlight.foreground3": LIGHT.teal,
	"editorBracketHighlight.unexpectedBracket.foreground": LIGHT.red,
};

export const DARK_BRACKETS: Record<string, string> = {
	"editorBracketHighlight.foreground1": DARK.amber,
	"editorBracketHighlight.foreground2": DARK.sage,
	"editorBracketHighlight.foreground3": DARK.teal,
	"editorBracketHighlight.unexpectedBracket.foreground": DARK.red,
};
