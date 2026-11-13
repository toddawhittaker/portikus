import type { EditorScheme } from "./types.js";

/*!
 * Solarized Light and Solarized Dark, copied as published in Visual Studio Code
 * (microsoft/vscode, extensions/theme-solarized-light and theme-solarized-dark), which
 * ports the Solarized palette by Ethan Schoonover (altercation/solarized).
 *
 * Copyright (c) 2015 - present Microsoft Corporation
 * Copyright (c) 2011 Ethan Schoonover (Solarized palette)
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to
 * deal in the Software without restriction, including without limitation the
 * rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
 * sell copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions: The above copyright
 * notice and this permission notice shall be included in all copies or
 * substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS IS",
 * WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED
 * TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
 * NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
 * LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF
 * CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
 * SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 */
/**
 * Solarized Light and Solarized Dark, copied as published. No colour is adjusted, so a
 * student who picks this scheme gets Solarized's contrast, which is weaker than
 * Portikus's (DESIGN.md section 11).
 *
 * Source: https://github.com/microsoft/vscode/tree/580745c3ba2151ca0108e613cebf90041942c0da/extensions/theme-solarized-light/themes and
 * theme-solarized-dark/themes (commit 580745c3ba2151ca0108e613cebf90041942c0da, 2026-11-13),
 * files solarized-light-color-theme.json and solarized-dark-color-theme.json.
 *
 * Each Monaco token id takes the colour of the TextMate scope named beside it. A token id
 * the theme has no rule for takes the theme's default foreground. An editor colour the
 * theme does not define is left out, so Monaco's base theme supplies it. The published
 * editorIndentGuide.background keys are the older names of editorIndentGuide.background1
 * and activeBackground1; the colours are unchanged.
 */
export const SOLARIZED: EditorScheme = {
	id: "solarized",
	label: "Solarized",
	source: {
		name: "Solarized Light and Solarized Dark, from Visual Studio Code",
		url: "https://github.com/microsoft/vscode/tree/580745c3ba2151ca0108e613cebf90041942c0da/extensions",
		licence: "MIT",
	},
	light: {
		base: "vs",
		tokens: {
			keyword: "859900", // keyword
			"keyword.flow": "859900", // keyword.control (rule keyword)
			"keyword.control": "859900", // keyword.control (rule keyword)
			"variable.predefined": "268BD2", // variable.language
			string: "2AA198", // string
			"string.escape": "CB4B16", // constant.character.escape (rule constant.character)
			"string.sql": "2AA198", // string
			"string.key.json": "859900", // support.type.property-name.json (rule support.type)
			"string.value.json": "2AA198", // string
			regexp: "DC322F", // string.regexp
			comment: "93A1A1", // comment
			"comment.doc": "93A1A1", // comment
			number: "D33682", // constant.numeric
			"number.hex": "D33682", // constant.numeric
			constant: "B58900", // constant.language
			type: "CB4B16", // entity.name.type
			"type.identifier": "CB4B16", // entity.name.type
			annotation: "586E75", // storage.type.annotation.java (rule storage)
			tag: "268BD2", // entity.name.tag
			"tag.id.pug": "93A1A1", // entity.other.attribute-name.id.css (rule entity.other.attribute-name)
			"tag.class.pug": "93A1A1", // entity.other.attribute-name.class.css (rule entity.other.attribute-name)
			metatag: "268BD2", // entity.name.tag
			"metatag.content.html": "2AA198", // string
			"metatag.html": "93A1A1", // punctuation.definition.tag
			"metatag.xml": "93A1A1", // punctuation.definition.tag
			"attribute.name": "93A1A1", // entity.other.attribute-name
			"attribute.value": "2AA198", // string.quoted.double.html (rule string)
			"attribute.value.number": "D33682", // constant.numeric
			"attribute.value.unit": "859900", // keyword.other.unit (rule keyword)
			"delimiter.html": "93A1A1", // punctuation.definition.tag
			"delimiter.xml": "93A1A1", // punctuation.definition.tag
			"operator.sql": "859900", // keyword.operator (rule keyword)
			"predefined.sql": "268BD2", // support.function
			identifier: "657B83", // default foreground (no rule for variable)
			invalid: "DC322F", // invalid.illegal (rule invalid)
		},
		fontStyles: {
			comment: "italic", // comment
			"comment.doc": "italic", // comment
			annotation: "bold", // storage.type.annotation.java
		},
		colors: {
			"editor.background": "#FDF6E3",
			"editor.foreground": "#657B83",
			"editor.lineHighlightBackground": "#EEE8D5",
			"editor.selectionBackground": "#EEE8D5",
			"editorCursor.foreground": "#657B83",
			"editorLineNumber.activeForeground": "#567983",
			"editorIndentGuide.background1": "#586E7580",
			"editorIndentGuide.activeBackground1": "#081E2580",
			"editorWidget.background": "#EEE8D5",
		},
	},
	dark: {
		base: "vs-dark",
		tokens: {
			keyword: "859900", // keyword
			"keyword.flow": "859900", // keyword.control (rule keyword)
			"keyword.control": "859900", // keyword.control (rule keyword)
			"variable.predefined": "268BD2", // variable.language
			string: "2AA198", // string
			"string.escape": "CB4B16", // constant.character.escape (rule constant.character)
			"string.sql": "2AA198", // string
			"string.key.json": "859900", // support.type.property-name.json (rule support.type)
			"string.value.json": "2AA198", // string
			regexp: "DC322F", // string.regexp
			comment: "586E75", // comment
			"comment.doc": "586E75", // comment
			number: "D33682", // constant.numeric
			"number.hex": "D33682", // constant.numeric
			constant: "B58900", // constant.language
			type: "CB4B16", // entity.name.type
			"type.identifier": "CB4B16", // entity.name.type
			annotation: "93A1A1", // storage.type.annotation.java (rule storage)
			tag: "268BD2", // entity.name.tag
			"tag.id.pug": "93A1A1", // entity.other.attribute-name.id.css (rule entity.other.attribute-name)
			"tag.class.pug": "93A1A1", // entity.other.attribute-name.class.css (rule entity.other.attribute-name)
			metatag: "268BD2", // entity.name.tag
			"metatag.content.html": "2AA198", // string
			"metatag.html": "586E75", // punctuation.definition.tag
			"metatag.xml": "586E75", // punctuation.definition.tag
			"attribute.name": "93A1A1", // entity.other.attribute-name
			"attribute.value": "2AA198", // string.quoted.double.html (rule string)
			"attribute.value.number": "D33682", // constant.numeric
			"attribute.value.unit": "859900", // keyword.other.unit (rule keyword)
			"delimiter.html": "586E75", // punctuation.definition.tag
			"delimiter.xml": "586E75", // punctuation.definition.tag
			"operator.sql": "859900", // keyword.operator (rule keyword)
			"predefined.sql": "268BD2", // support.function
			identifier: "839496", // default foreground (no rule for variable)
			invalid: "DC322F", // invalid.illegal (rule invalid)
		},
		fontStyles: {
			comment: "italic", // comment
			"comment.doc": "italic", // comment
			annotation: "bold", // storage.type.annotation.java
		},
		colors: {
			"editor.background": "#002B36",
			"editor.foreground": "#839496",
			"editor.lineHighlightBackground": "#073642",
			"editor.selectionBackground": "#274642",
			"editor.selectionHighlightBackground": "#005A6FAA",
			"editorCursor.foreground": "#D30102",
			"editorLineNumber.activeForeground": "#949494",
			"editorIndentGuide.background1": "#93A1A180",
			"editorIndentGuide.activeBackground1": "#C3E1E180",
			"editorWidget.background": "#00212B",
			"editorBracketHighlight.foreground1": "#cdcdcdff",
			"editorBracketHighlight.foreground2": "#b58900ff",
			"editorBracketHighlight.foreground3": "#d33682ff",
		},
	},
};
