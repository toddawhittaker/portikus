/**
 * The editor's ground and its current-line highlight in each theme: the
 * --surface-work and --surface tokens of packages/ui/src/theme.css in light,
 * --surface-work and --surface-raised in dark.
 */
export const EDITOR_BACKGROUNDS = {
	light: { ground: "fffdf8", line: "f5f1e8" },
	dark: { ground: "22211f", line: "2a2825" },
} as const;

/**
 * Syntax colours from the chrome's own hues, so the editor belongs to the
 * product: violet keywords and tags (the agent hue), teal strings (the
 * accent), terracotta numbers and constants, amber types and decorators,
 * and the faint ink for comments. Every one reads at 4.5:1 or better on the
 * editor and line-highlight backgrounds (SPEC.md section 25.8).
 */
const LIGHT = {
	violet: "5a36b8",
	teal: "0e6b62",
	terracotta: "b23a1e",
	amber: "8a5300",
	blue: "2f58a8",
	faint: "6b6458",
	ink: "221f1a",
	red: "b0372b",
};

const DARK = {
	violet: "bba6ff",
	teal: "5fd0bf",
	terracotta: "f4957c",
	amber: "f0c062",
	blue: "93b6f2",
	faint: "a29b8f",
	ink: "f0ebe1",
	red: "f59a8e",
};

function tokens(c: typeof LIGHT): Record<string, string> {
	return {
		keyword: c.violet,
		"keyword.flow": c.violet,
		"keyword.control": c.violet,
		"variable.predefined": c.terracotta,
		string: c.teal,
		"string.escape": c.terracotta,
		"string.sql": c.teal,
		"string.key.json": c.violet,
		"string.value.json": c.teal,
		regexp: c.terracotta,
		comment: c.faint,
		"comment.doc": c.faint,
		number: c.terracotta,
		"number.hex": c.terracotta,
		constant: c.terracotta,
		type: c.amber,
		"type.identifier": c.amber,
		annotation: c.amber,
		tag: c.violet,
		"tag.id.pug": c.amber,
		"tag.class.pug": c.amber,
		metatag: c.violet,
		"metatag.content.html": c.teal,
		"metatag.html": c.faint,
		"metatag.xml": c.faint,
		"attribute.name": c.amber,
		"attribute.value": c.teal,
		"attribute.value.number": c.terracotta,
		"attribute.value.unit": c.terracotta,
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
	"editorBracketHighlight.foreground2": LIGHT.violet,
	"editorBracketHighlight.foreground3": LIGHT.teal,
	"editorBracketHighlight.unexpectedBracket.foreground": LIGHT.red,
};

export const DARK_BRACKETS: Record<string, string> = {
	"editorBracketHighlight.foreground1": DARK.amber,
	"editorBracketHighlight.foreground2": DARK.violet,
	"editorBracketHighlight.foreground3": DARK.teal,
	"editorBracketHighlight.unexpectedBracket.foreground": DARK.red,
};
