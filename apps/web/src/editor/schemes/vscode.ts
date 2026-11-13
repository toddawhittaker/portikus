import type { EditorScheme } from "./types.js";

/*!
 * VS Code Light Modern and Dark Modern, copied as published in microsoft/vscode,
 * extensions/theme-defaults/themes.
 *
 * MIT License. Copyright (c) 2015 - present Microsoft Corporation.
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions: The above copyright
 * notice and this permission notice shall be included in all copies or
 * substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS IS",
 * WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED
 * TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
 * NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE
 * FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
 * TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR
 * THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 */
/**
 * VS Code's Light Modern and Dark Modern, copied as published. No colour is
 * adjusted, so a student who picks this scheme gets VS Code's contrast, which
 * is weaker than Portikus's (DESIGN.md section 11).
 *
 * Source: https://github.com/microsoft/vscode/tree/580745c3ba2151ca0108e613cebf90041942c0da/extensions/theme-defaults/themes
 * (commit 580745c3ba2151ca0108e613cebf90041942c0da, 2026-11-13).
 *   light_modern.json includes light_plus.json includes light_vs.json
 *   dark_modern.json  includes dark_plus.json  includes dark_vs.json
 * Each pair is resolved with its includes, a later file overriding an earlier one.
 * The 2026-light and 2026-dark themes are left out on purpose: their syntax
 * colours are close to the GitHub scheme.
 *
 * Each Monaco token id takes the colour of the TextMate scope named beside it.
 * Where the scopes of one language differ, the one students meet most is used.
 * An editor colour the source does not define is left out, so Monaco's base
 * theme supplies it. Neither theme gives a token a font style, so none is set:
 * VS Code's comments are not italic.
 */
export const VSCODE: EditorScheme = {
	id: "vscode",
	label: "VS Code",
	source: {
		name: "Visual Studio Code, Light Modern and Dark Modern",
		url: "https://github.com/microsoft/vscode/tree/580745c3ba2151ca0108e613cebf90041942c0da/extensions/theme-defaults/themes",
		licence: "MIT",
	},
	light: {
		base: "vs",
		tokens: {
			keyword: "0000ff", // keyword
			"keyword.flow": "AF00DB", // keyword.control
			"keyword.control": "AF00DB", // keyword.control
			"variable.predefined": "0000ff", // variable.language
			string: "a31515", // string
			"string.escape": "EE0000", // constant.character.escape
			"string.sql": "a31515", // string
			"string.key.json": "0451a5", // support.type.property-name.json
			"string.value.json": "a31515", // string
			regexp: "811f3f", // string.regexp
			comment: "008000", // comment
			"comment.doc": "008000", // comment
			number: "098658", // constant.numeric
			"number.hex": "098658", // constant.numeric
			constant: "0000ff", // constant.language
			type: "267f99", // entity.name.type
			"type.identifier": "267f99", // entity.name.type
			annotation: "267f99", // storage.type.annotation.java
			tag: "800000", // entity.name.tag
			"tag.id.pug": "800000", // entity.other.attribute-name.id.css
			"tag.class.pug": "800000", // entity.other.attribute-name.class.css
			metatag: "800000", // entity.name.tag
			"metatag.content.html": "a31515", // string
			"metatag.html": "800000", // punctuation.definition.tag
			"metatag.xml": "800000", // punctuation.definition.tag
			"attribute.name": "e50000", // entity.other.attribute-name
			"attribute.value": "0000ff", // string.quoted.double.html
			"attribute.value.number": "098658", // constant.numeric
			"attribute.value.unit": "098658", // keyword.other.unit
			"delimiter.html": "800000", // punctuation.definition.tag
			"delimiter.xml": "800000", // punctuation.definition.tag
			"operator.sql": "000000", // keyword.operator
			"predefined.sql": "795E26", // support.function
			identifier: "001080", // variable
			invalid: "cd3131", // invalid
		},
		colors: {
			"editor.background": "#FFFFFF",
			"editor.foreground": "#3B3B3B",
			"editor.inactiveSelectionBackground": "#E5EBF1",
			"editor.selectionHighlightBackground": "#ADD6FF80",
			"editorLineNumber.foreground": "#6E7681",
			"editorLineNumber.activeForeground": "#171184",
			"editorIndentGuide.background1": "#D3D3D3",
			"editorIndentGuide.activeBackground1": "#939393",
			"editorWidget.background": "#F8F8F8",
			"textLink.foreground": "#005FB8",
			"textLink.activeForeground": "#005FB8",
		},
	},
	dark: {
		base: "vs-dark",
		tokens: {
			keyword: "569cd6", // keyword
			"keyword.flow": "C586C0", // keyword.control
			"keyword.control": "C586C0", // keyword.control
			"variable.predefined": "569cd6", // variable.language
			string: "ce9178", // string
			"string.escape": "d7ba7d", // constant.character.escape
			"string.sql": "ce9178", // string
			"string.key.json": "9cdcfe", // support.type.property-name
			"string.value.json": "ce9178", // string
			regexp: "d16969", // string.regexp
			comment: "6A9955", // comment
			"comment.doc": "6A9955", // comment
			number: "b5cea8", // constant.numeric
			"number.hex": "b5cea8", // constant.numeric
			constant: "569cd6", // constant.language
			type: "4EC9B0", // entity.name.type
			"type.identifier": "4EC9B0", // entity.name.type
			annotation: "4EC9B0", // storage.type.annotation.java
			tag: "569cd6", // entity.name.tag
			"tag.id.pug": "d7ba7d", // entity.other.attribute-name.id.css
			"tag.class.pug": "d7ba7d", // entity.other.attribute-name.class.css
			metatag: "569cd6", // entity.name.tag
			"metatag.content.html": "ce9178", // string
			"metatag.html": "808080", // punctuation.definition.tag
			"metatag.xml": "808080", // punctuation.definition.tag
			"attribute.name": "9cdcfe", // entity.other.attribute-name
			"attribute.value": "ce9178", // string.quoted.double.html
			"attribute.value.number": "b5cea8", // constant.numeric
			"attribute.value.unit": "b5cea8", // keyword.other.unit
			"delimiter.html": "808080", // punctuation.definition.tag
			"delimiter.xml": "808080", // punctuation.definition.tag
			"operator.sql": "d4d4d4", // keyword.operator
			"predefined.sql": "DCDCAA", // support.function
			identifier: "9CDCFE", // variable
			invalid: "f44747", // invalid
		},
		colors: {
			"editor.background": "#1F1F1F",
			"editor.foreground": "#CCCCCC",
			"editor.inactiveSelectionBackground": "#3A3D41",
			"editor.selectionHighlightBackground": "#ADD6FF26",
			"editorLineNumber.foreground": "#6E7681",
			"editorLineNumber.activeForeground": "#CCCCCC",
			"editorIndentGuide.background1": "#404040",
			"editorIndentGuide.activeBackground1": "#707070",
			"editorWidget.background": "#202020",
			"textLink.foreground": "#4daafc",
			"textLink.activeForeground": "#4daafc",
		},
	},
};
