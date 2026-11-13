import type { EditorScheme, SchemeMode } from "./types.js";

/**
 * Portikus's own scheme, the default. Syntax colours come from warm hues,
 * distinct from one another: terracotta keywords and tags, sage strings, teal
 * numbers and constants, amber types and attributes, blue SQL built-ins, and
 * the faint ink for comments. Violet stays out of them, as it means a coding
 * agent in the app's own interface (DESIGN.md section 11). Every one reads at
 * 4.5:1 or better on the editor and line-highlight backgrounds (SPEC.md
 * section 25.8); portikus.test.ts holds that line.
 *
 * The editor's ground and line highlight are the --surface-work and --surface
 * tokens of packages/ui/src/theme.css.
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

/** Bracket pair colours, in three of the same families, so nesting reads without a clash. */
function brackets(c: typeof LIGHT): Record<string, string> {
	return {
		"editorBracketHighlight.foreground1": `#${c.amber}`,
		"editorBracketHighlight.foreground2": `#${c.sage}`,
		"editorBracketHighlight.foreground3": `#${c.teal}`,
		"editorBracketHighlight.unexpectedBracket.foreground": `#${c.red}`,
	};
}

const light: SchemeMode = {
	base: "vs",
	tokens: tokens(LIGHT),
	colors: {
		"editor.background": "#fffdf8",
		"editor.foreground": "#221f1a",
		"editor.lineHighlightBackground": "#f5f1e8",
		"editor.selectionBackground": "#cce9e2",
		"editorCursor.foreground": "#1d6e67",
		"editorLineNumber.foreground": "#675f53",
		"editorLineNumber.activeForeground": "#221f1a",
		"editorIndentGuide.background1": "#e2dacb",
		"editorWidget.background": "#ffffff",
		// Links in code help's hover, such as View Problem, in the accent.
		"textLink.foreground": "#17625b",
		"textLink.activeForeground": "#10443f",
		"editorWidget.border": "#e2dacb",
		// The split view's code side needs a scrollbar a student can see
		// against a pale background.
		"scrollbarSlider.background": "#c1b9a8cc",
		"scrollbarSlider.hoverBackground": "#a89f8ce6",
		"scrollbarSlider.activeBackground": "#8d8472",
		"scrollbar.shadow": "#00000000",
		...brackets(LIGHT),
	},
};

const dark: SchemeMode = {
	base: "vs-dark",
	tokens: tokens(DARK),
	colors: {
		"editor.background": "#171614",
		"editor.foreground": "#f0ebe1",
		"editor.lineHighlightBackground": "#1f1e1b",
		"editor.selectionBackground": "#183f3a",
		"editorCursor.foreground": "#5fcfbf",
		"editorLineNumber.foreground": "#aaa396",
		"editorLineNumber.activeForeground": "#f0ebe1",
		"editorIndentGuide.background1": "#2f2d29",
		"editorWidget.background": "#2a2825",
		"textLink.foreground": "#7fd9cc",
		"textLink.activeForeground": "#a6e8de",
		"editorWidget.border": "#36332e",
		"scrollbarSlider.background": "#4b473fcc",
		"scrollbarSlider.hoverBackground": "#615c52e6",
		"scrollbarSlider.activeBackground": "#7a7466",
		"scrollbar.shadow": "#00000000",
		...brackets(DARK),
	},
};

export const PORTIKUS: EditorScheme = {
	id: "portikus",
	label: "Portikus",
	light,
	dark,
};
