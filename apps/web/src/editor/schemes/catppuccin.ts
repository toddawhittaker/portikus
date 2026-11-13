import type { EditorScheme } from "./types.js";

/*!
 * Catppuccin Latte and Catppuccin Mocha, copied as published from the
 * catppuccin-vsc 3.19.0 extension (catppuccin/vscode).
 *
 * Copyright (c) 2021 Catppuccin
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
 * Catppuccin Latte (light) and Catppuccin Mocha (dark), copied as published. No colour is
 * adjusted, so a student who picks this scheme gets Catppuccin's contrast, which is
 * weaker than Portikus's (DESIGN.md section 11).
 *
 * Source: catppuccin-vsc 3.19.0, tag catppuccin-vsc-v3.19.0 (commit
 * befc9e6fc41980f4241408f7049755d47c06ff45) of https://github.com/catppuccin/vscode. The
 * themes are generated from the repository, so the colours are read from the compiled
 * themes/latte.json and themes/mocha.json in the release asset catppuccin-vsc-3.19.0.vsix.
 *
 * Each Monaco token id takes the colour of the TextMate scope named beside it. A token id
 * the theme has no rule for takes the theme's default foreground. An editor colour the
 * theme does not define is left out, so Monaco's base theme supplies it. The theme has no
 * rule for variable.language itself, only for its this, self and super forms, so the token
 * id for predefined variables takes the scope variable.language.this.
 */
export const CATPPUCCIN: EditorScheme = {
	id: "catppuccin",
	label: "Catppuccin",
	source: {
		name: "Catppuccin Latte and Catppuccin Mocha, from the published catppuccin-vsc 3.19.0",
		url: "https://github.com/catppuccin/vscode/tree/befc9e6fc41980f4241408f7049755d47c06ff45",
		licence: "MIT",
	},
	light: {
		base: "vs",
		tokens: {
			keyword: "8839ef", // keyword
			"keyword.flow": "8839ef", // keyword.control (rule keyword)
			"keyword.control": "8839ef", // keyword.control (rule keyword)
			"variable.predefined": "d20f39", // variable.language.this
			string: "40a02b", // string
			"string.escape": "ea76cb", // constant.character.escape
			"string.sql": "40a02b", // string
			"string.key.json": "1e66f5", // support.type.property-name.json
			"string.value.json": "40a02b", // string
			regexp: "40a02b", // string.regexp (rule string)
			comment: "7c7f93", // comment
			"comment.doc": "7c7f93", // comment
			number: "fe640b", // constant.numeric
			"number.hex": "fe640b", // constant.numeric
			constant: "d20f39", // constant.language
			type: "df8e1d", // entity.name.type
			"type.identifier": "df8e1d", // entity.name.type
			annotation: "fe640b", // storage.type.annotation.java (rule storage.type.annotation)
			tag: "1e66f5", // entity.name.tag
			"tag.id.pug": "df8e1d", // entity.other.attribute-name.id.css (rule entity.other.attribute-name)
			"tag.class.pug": "df8e1d", // entity.other.attribute-name.class.css (rule entity.other.attribute-name)
			metatag: "1e66f5", // entity.name.tag
			"metatag.content.html": "40a02b", // string
			"metatag.html": "179299", // punctuation.definition.tag
			"metatag.xml": "179299", // punctuation.definition.tag
			"attribute.name": "df8e1d", // entity.other.attribute-name
			"attribute.value": "40a02b", // string.quoted.double.html (rule string)
			"attribute.value.number": "fe640b", // constant.numeric
			"attribute.value.unit": "8839ef", // keyword.other.unit (rule keyword)
			"delimiter.html": "179299", // punctuation.definition.tag
			"delimiter.xml": "179299", // punctuation.definition.tag
			"operator.sql": "179299", // keyword.operator
			"predefined.sql": "1e66f5", // support.function
			identifier: "4c4f69", // default foreground (no rule for variable)
			invalid: "4c4f69", // default foreground (no rule for invalid.illegal)
		},
		fontStyles: {
			comment: "italic", // comment
			"comment.doc": "italic", // comment
			type: "italic", // entity.name.type
			"type.identifier": "italic", // entity.name.type
			"predefined.sql": "italic", // support.function
		},
		colors: {
			"editor.background": "#eff1f5",
			"editor.foreground": "#4c4f69",
			"editor.lineHighlightBackground": "#4c4f6912",
			"editor.selectionBackground": "#7c7f934d",
			"editor.selectionHighlightBackground": "#7c7f9333",
			"editorCursor.foreground": "#dc8a78",
			"editorLineNumber.foreground": "#8c8fa1",
			"editorLineNumber.activeForeground": "#8839ef",
			"editorIndentGuide.background1": "#bcc0cc",
			"editorIndentGuide.activeBackground1": "#acb0be",
			"editorWidget.background": "#e6e9ef",
			"textLink.foreground": "#1e66f5",
			"textLink.activeForeground": "#04a5e5",
			"scrollbarSlider.background": "#acb0be80",
			"scrollbarSlider.hoverBackground": "#9ca0b0",
			"scrollbarSlider.activeBackground": "#ccd0da66",
			"scrollbar.shadow": "#dce0e8",
			"editorBracketHighlight.foreground1": "#d20f39",
			"editorBracketHighlight.foreground2": "#fe640b",
			"editorBracketHighlight.foreground3": "#df8e1d",
			"editorBracketHighlight.foreground4": "#40a02b",
			"editorBracketHighlight.foreground5": "#209fb5",
			"editorBracketHighlight.foreground6": "#8839ef",
			"editorBracketHighlight.unexpectedBracket.foreground": "#e64553",
		},
	},
	dark: {
		base: "vs-dark",
		tokens: {
			keyword: "cba6f7", // keyword
			"keyword.flow": "cba6f7", // keyword.control (rule keyword)
			"keyword.control": "cba6f7", // keyword.control (rule keyword)
			"variable.predefined": "f38ba8", // variable.language.this
			string: "a6e3a1", // string
			"string.escape": "f5c2e7", // constant.character.escape
			"string.sql": "a6e3a1", // string
			"string.key.json": "89b4fa", // support.type.property-name.json
			"string.value.json": "a6e3a1", // string
			regexp: "a6e3a1", // string.regexp (rule string)
			comment: "9399b2", // comment
			"comment.doc": "9399b2", // comment
			number: "fab387", // constant.numeric
			"number.hex": "fab387", // constant.numeric
			constant: "f38ba8", // constant.language
			type: "f9e2af", // entity.name.type
			"type.identifier": "f9e2af", // entity.name.type
			annotation: "fab387", // storage.type.annotation.java (rule storage.type.annotation)
			tag: "89b4fa", // entity.name.tag
			"tag.id.pug": "f9e2af", // entity.other.attribute-name.id.css (rule entity.other.attribute-name)
			"tag.class.pug": "f9e2af", // entity.other.attribute-name.class.css (rule entity.other.attribute-name)
			metatag: "89b4fa", // entity.name.tag
			"metatag.content.html": "a6e3a1", // string
			"metatag.html": "94e2d5", // punctuation.definition.tag
			"metatag.xml": "94e2d5", // punctuation.definition.tag
			"attribute.name": "f9e2af", // entity.other.attribute-name
			"attribute.value": "a6e3a1", // string.quoted.double.html (rule string)
			"attribute.value.number": "fab387", // constant.numeric
			"attribute.value.unit": "cba6f7", // keyword.other.unit (rule keyword)
			"delimiter.html": "94e2d5", // punctuation.definition.tag
			"delimiter.xml": "94e2d5", // punctuation.definition.tag
			"operator.sql": "94e2d5", // keyword.operator
			"predefined.sql": "89b4fa", // support.function
			identifier: "cdd6f4", // default foreground (no rule for variable)
			invalid: "cdd6f4", // default foreground (no rule for invalid.illegal)
		},
		fontStyles: {
			comment: "italic", // comment
			"comment.doc": "italic", // comment
			type: "italic", // entity.name.type
			"type.identifier": "italic", // entity.name.type
			"predefined.sql": "italic", // support.function
		},
		colors: {
			"editor.background": "#1e1e2e",
			"editor.foreground": "#cdd6f4",
			"editor.lineHighlightBackground": "#cdd6f412",
			"editor.selectionBackground": "#9399b240",
			"editor.selectionHighlightBackground": "#9399b233",
			"editorCursor.foreground": "#f5e0dc",
			"editorLineNumber.foreground": "#7f849c",
			"editorLineNumber.activeForeground": "#cba6f7",
			"editorIndentGuide.background1": "#45475a",
			"editorIndentGuide.activeBackground1": "#585b70",
			"editorWidget.background": "#181825",
			"textLink.foreground": "#89b4fa",
			"textLink.activeForeground": "#89dceb",
			"scrollbarSlider.background": "#585b7080",
			"scrollbarSlider.hoverBackground": "#6c7086",
			"scrollbarSlider.activeBackground": "#31324466",
			"scrollbar.shadow": "#11111b",
			"editorBracketHighlight.foreground1": "#f38ba8",
			"editorBracketHighlight.foreground2": "#fab387",
			"editorBracketHighlight.foreground3": "#f9e2af",
			"editorBracketHighlight.foreground4": "#a6e3a1",
			"editorBracketHighlight.foreground5": "#74c7ec",
			"editorBracketHighlight.foreground6": "#cba6f7",
			"editorBracketHighlight.unexpectedBracket.foreground": "#eba0ac",
		},
	},
};
