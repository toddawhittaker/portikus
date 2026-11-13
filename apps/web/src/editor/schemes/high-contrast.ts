import type { EditorScheme } from "./types.js";

/*!
 * VS Code Light High Contrast (hc_light.json) and Dark High Contrast (hc_black.json),
 * copied as published in microsoft/vscode, extensions/theme-defaults/themes.
 *
 * Copyright (c) 2015 - present Microsoft Corporation
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
 * VS Code's two high contrast themes, copied as published. No colour is adjusted. The pair
 * is here for students with low vision, so the Monaco bases are hc-light and hc-black.
 *
 * Source: https://github.com/microsoft/vscode/tree/580745c3ba2151ca0108e613cebf90041942c0da/extensions/theme-defaults/themes
 * (commit 580745c3ba2151ca0108e613cebf90041942c0da, 2026-11-13), files hc_light.json and
 * hc_black.json.
 *
 * Each Monaco token id takes the colour of the TextMate scope named beside it. An editor
 * colour the theme does not define is left out, so Monaco's base theme supplies it. That
 * is every editor colour in hc_light.json, including the background and foreground, which
 * Monaco's hc-light theme sets to white and its own text colour.
 */
export const HIGH_CONTRAST: EditorScheme = {
	id: "high-contrast",
	label: "High contrast",
	source: {
		name: "Visual Studio Code, Light High Contrast and Dark High Contrast",
		url: "https://github.com/microsoft/vscode/tree/580745c3ba2151ca0108e613cebf90041942c0da/extensions/theme-defaults/themes",
		licence: "MIT",
	},
	light: {
		base: "hc-light",
		tokens: {
			keyword: "0F4A85", // keyword
			"keyword.flow": "b5200d", // keyword.control
			"keyword.control": "b5200d", // keyword.control
			"variable.predefined": "0F4A85", // variable.language
			string: "0F4A85", // string
			"string.escape": "EE0000", // constant.character.escape
			"string.sql": "0F4A85", // string
			"string.key.json": "0451A5", // support.type.property-name.json
			"string.value.json": "0F4A85", // string
			regexp: "811F3F", // string.regexp
			comment: "515151", // comment
			"comment.doc": "515151", // comment
			number: "096d48", // constant.numeric
			"number.hex": "096d48", // constant.numeric
			constant: "0F4A85", // constant.language
			type: "185E73", // entity.name.type
			"type.identifier": "185E73", // entity.name.type
			annotation: "185E73", // storage.type.annotation.java
			tag: "0F4A85", // entity.name.tag
			"tag.id.pug": "0F4A85", // entity.other.attribute-name.id.css
			"tag.class.pug": "0F4A85", // entity.other.attribute-name.class.css
			metatag: "0F4A85", // entity.name.tag
			"metatag.content.html": "0F4A85", // string
			"metatag.html": "0F4A85", // punctuation.definition.tag
			"metatag.xml": "0F4A85", // punctuation.definition.tag
			"attribute.name": "264F78", // entity.other.attribute-name
			"attribute.value": "0F4A85", // string.quoted.double.html
			"attribute.value.number": "096d48", // constant.numeric
			"attribute.value.unit": "096d48", // keyword.other.unit
			"delimiter.html": "0F4A85", // punctuation.definition.tag
			"delimiter.xml": "0F4A85", // punctuation.definition.tag
			"operator.sql": "000000", // keyword.operator
			"predefined.sql": "5e2cbc", // support.function
			identifier: "001080", // variable
			invalid: "B5200D", // invalid.illegal (rule invalid)
		},
		colors: {},
	},
	dark: {
		base: "hc-black",
		// jscpd:ignore-start -- hc_black.json publishes the same token colours as Dark Modern.
		tokens: {
			keyword: "569cd6", // keyword
			"keyword.flow": "C586C0", // keyword.control
			"keyword.control": "C586C0", // keyword.control
			"variable.predefined": "9CDCFE", // variable.language (rule variable)
			string: "ce9178", // string
			"string.escape": "569cd6", // constant.character.escape (rule constant.character)
			"string.sql": "ce9178", // string
			"string.key.json": "d4d4d4", // support.type.property-name.json (rule support.type.property-name)
			"string.value.json": "ce9178", // string
			regexp: "d16969", // string.regexp
			comment: "7ca668", // comment
			"comment.doc": "7ca668", // comment
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
			"attribute.value": "ce9178", // string.quoted.double.html (rule string)
			"attribute.value.number": "b5cea8", // constant.numeric
			"attribute.value.unit": "b5cea8", // keyword.other.unit
			"delimiter.html": "808080", // punctuation.definition.tag
			"delimiter.xml": "808080", // punctuation.definition.tag
			"operator.sql": "d4d4d4", // keyword.operator
			"predefined.sql": "DCDCAA", // support.function
			identifier: "9CDCFE", // variable
			invalid: "f44747", // invalid.illegal (rule invalid)
		},
		// jscpd:ignore-end
		colors: {
			"editor.background": "#000000",
			"editor.foreground": "#FFFFFF",
			"editor.selectionBackground": "#FFFFFF",
			"editorIndentGuide.background1": "#FFFFFF",
			"editorIndentGuide.activeBackground1": "#FFFFFF",
		},
	},
};
