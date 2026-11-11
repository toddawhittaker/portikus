/**
 * The editor's ground and its current-line highlight in each theme: the
 * work surface of packages/ui/src/theme.css and one step under it.
 */
export const EDITOR_BACKGROUNDS = {
	light: { ground: "fdfcf9", line: "f3f1eb" },
	dark: { ground: "201f1c", line: "292825" },
} as const;

/**
 * Syntax colours in families shared by both themes: violet keywords, green
 * strings, orange numbers and constants, blue types and decorators, teal
 * escapes and attribute names, and the faint ink for comments. Every one
 * reads at 4.5:1 or better on the editor and line-highlight backgrounds
 * (SPEC.md section 25.8).
 */
const LIGHT = {
	violet: "7a3e9d",
	green: "3b7328",
	orange: "a14a00",
	blue: "2d5fb0",
	teal: "1f6b66",
	faint: "5d6461",
	ink: "1e2220",
	red: "a4342a",
};

const DARK = {
	violet: "c9a0e8",
	green: "a6d189",
	orange: "eda16b",
	blue: "8db4ef",
	teal: "7cc2b9",
	faint: "959b97",
	ink: "ece8df",
	red: "f0998f",
};

function tokens(c: typeof LIGHT): Record<string, string> {
	return {
		keyword: c.violet,
		"keyword.flow": c.violet,
		"keyword.control": c.violet,
		"variable.predefined": c.orange,
		string: c.green,
		"string.escape": c.teal,
		"string.sql": c.green,
		"string.key.json": c.blue,
		"string.value.json": c.green,
		regexp: c.green,
		comment: c.faint,
		"comment.doc": c.faint,
		number: c.orange,
		"number.hex": c.orange,
		constant: c.orange,
		type: c.blue,
		"type.identifier": c.blue,
		annotation: c.blue,
		tag: c.violet,
		"tag.id.pug": c.blue,
		"tag.class.pug": c.blue,
		metatag: c.violet,
		"metatag.content.html": c.green,
		"metatag.html": c.faint,
		"metatag.xml": c.faint,
		"attribute.name": c.teal,
		"attribute.value": c.green,
		"attribute.value.number": c.orange,
		"attribute.value.unit": c.orange,
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
	"editorBracketHighlight.foreground1": LIGHT.blue,
	"editorBracketHighlight.foreground2": LIGHT.violet,
	"editorBracketHighlight.foreground3": LIGHT.teal,
	"editorBracketHighlight.unexpectedBracket.foreground": LIGHT.red,
};

export const DARK_BRACKETS: Record<string, string> = {
	"editorBracketHighlight.foreground1": DARK.blue,
	"editorBracketHighlight.foreground2": DARK.violet,
	"editorBracketHighlight.foreground3": DARK.teal,
	"editorBracketHighlight.unexpectedBracket.foreground": DARK.red,
};
