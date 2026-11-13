import type { EditorScheme } from "./types.js";

/*!
 * GitHub Light Default and GitHub Dark Default, copied as published from the
 * github-vscode-theme extension 6.3.5 (primer/github-vscode-theme).
 *
 * Copyright (c) 2020 Primer
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
 * GitHub Light Default and GitHub Dark Default, copied as published. No colour is
 * adjusted, so a student who picks this scheme gets GitHub's contrast, which is weaker
 * than Portikus's (DESIGN.md section 11).
 *
 * Source: github-vscode-theme 6.3.5, tag v6.3.5 (commit 3f1363be5d8cec24724430e3872628d42cb12cd0)
 * of https://github.com/primer/github-vscode-theme. The repository holds the generator,
 * not the theme files, so the colours are read from the published extension itself,
 * GitHub.github-vscode-theme-6.3.5.vsix (Open VSX), files themes/light-default.json and
 * themes/dark-default.json.
 *
 * Each Monaco token id takes the colour of the TextMate scope named beside it. A token id
 * the theme has no rule for takes the theme's default foreground. An editor colour the
 * theme does not define is left out, so Monaco's base theme supplies it. The published
 * editorIndentGuide.background keys are the older names of editorIndentGuide.background1
 * and activeBackground1; the colours are unchanged.
 */
export const GITHUB: EditorScheme = {
	id: "github",
	label: "GitHub",
	source: {
		name: "GitHub Light Default and GitHub Dark Default, from the published github-vscode-theme 6.3.5",
		url: "https://github.com/primer/github-vscode-theme/tree/3f1363be5d8cec24724430e3872628d42cb12cd0",
		licence: "MIT",
	},
	light: {
		base: "vs",
		tokens: {
			keyword: "cf222e", // keyword
			"keyword.flow": "cf222e", // keyword.control (rule keyword)
			"keyword.control": "cf222e", // keyword.control (rule keyword)
			"variable.predefined": "0550ae", // variable.language
			string: "0a3069", // string
			"string.escape": "cf222e", // constant.character.escape (rule constant.character)
			"string.sql": "0a3069", // string
			"string.key.json": "116329", // support.type.property-name.json
			"string.value.json": "0a3069", // string
			regexp: "0a3069", // string.regexp
			comment: "6e7781", // comment
			"comment.doc": "6e7781", // comment
			number: "0550ae", // constant.numeric (rule constant)
			"number.hex": "0550ae", // constant.numeric (rule constant)
			constant: "0550ae", // constant.language (rule constant)
			type: "953800", // entity.name.type (rule entity.name)
			"type.identifier": "953800", // entity.name.type (rule entity.name)
			annotation: "cf222e", // storage.type.annotation.java (rule storage.type)
			tag: "116329", // entity.name.tag
			"tag.id.pug": "0550ae", // entity.other.attribute-name.id.css (rule entity)
			"tag.class.pug": "0550ae", // entity.other.attribute-name.class.css (rule entity)
			metatag: "116329", // entity.name.tag
			"metatag.content.html": "0a3069", // string
			"metatag.html": "1f2328", // default foreground (no rule for punctuation.definition.tag)
			"metatag.xml": "1f2328", // default foreground (no rule for punctuation.definition.tag)
			"attribute.name": "0550ae", // entity.other.attribute-name (rule entity)
			"attribute.value": "0a3069", // string.quoted.double.html (rule string)
			"attribute.value.number": "0550ae", // constant.numeric (rule constant)
			"attribute.value.unit": "cf222e", // keyword.other.unit (rule keyword)
			"delimiter.html": "1f2328", // default foreground (no rule for punctuation.definition.tag)
			"delimiter.xml": "1f2328", // default foreground (no rule for punctuation.definition.tag)
			"operator.sql": "cf222e", // keyword.operator (rule keyword)
			"predefined.sql": "0550ae", // support.function (rule support)
			identifier: "953800", // variable
			invalid: "82071e", // invalid.illegal
		},
		fontStyles: {
			invalid: "italic", // invalid.illegal
		},
		colors: {
			"editor.background": "#ffffff",
			"editor.foreground": "#1f2328",
			"editor.lineHighlightBackground": "#eaeef280",
			"editor.selectionHighlightBackground": "#4ac26b40",
			"editorCursor.foreground": "#0969da",
			"editorLineNumber.foreground": "#8c959f",
			"editorLineNumber.activeForeground": "#1f2328",
			"editorIndentGuide.background1": "#1f23281f",
			"editorIndentGuide.activeBackground1": "#1f23283d",
			"editorWidget.background": "#ffffff",
			"textLink.foreground": "#0969da",
			"textLink.activeForeground": "#0969da",
			"scrollbarSlider.background": "#8c959f33",
			"scrollbarSlider.hoverBackground": "#8c959f3d",
			"scrollbarSlider.activeBackground": "#8c959f47",
			"scrollbar.shadow": "#6e778133",
			"editorBracketHighlight.foreground1": "#0969da",
			"editorBracketHighlight.foreground2": "#1a7f37",
			"editorBracketHighlight.foreground3": "#9a6700",
			"editorBracketHighlight.foreground4": "#cf222e",
			"editorBracketHighlight.foreground5": "#bf3989",
			"editorBracketHighlight.foreground6": "#8250df",
			"editorBracketHighlight.unexpectedBracket.foreground": "#656d76",
		},
	},
	dark: {
		base: "vs-dark",
		tokens: {
			keyword: "ff7b72", // keyword
			"keyword.flow": "ff7b72", // keyword.control (rule keyword)
			"keyword.control": "ff7b72", // keyword.control (rule keyword)
			"variable.predefined": "79c0ff", // variable.language
			string: "a5d6ff", // string
			"string.escape": "ff7b72", // constant.character.escape (rule constant.character)
			"string.sql": "a5d6ff", // string
			"string.key.json": "7ee787", // support.type.property-name.json
			"string.value.json": "a5d6ff", // string
			regexp: "a5d6ff", // string.regexp
			comment: "8b949e", // comment
			"comment.doc": "8b949e", // comment
			number: "79c0ff", // constant.numeric (rule constant)
			"number.hex": "79c0ff", // constant.numeric (rule constant)
			constant: "79c0ff", // constant.language (rule constant)
			type: "ffa657", // entity.name.type (rule entity.name)
			"type.identifier": "ffa657", // entity.name.type (rule entity.name)
			annotation: "ff7b72", // storage.type.annotation.java (rule storage.type)
			tag: "7ee787", // entity.name.tag
			"tag.id.pug": "79c0ff", // entity.other.attribute-name.id.css (rule entity)
			"tag.class.pug": "79c0ff", // entity.other.attribute-name.class.css (rule entity)
			metatag: "7ee787", // entity.name.tag
			"metatag.content.html": "a5d6ff", // string
			"metatag.html": "e6edf3", // default foreground (no rule for punctuation.definition.tag)
			"metatag.xml": "e6edf3", // default foreground (no rule for punctuation.definition.tag)
			"attribute.name": "79c0ff", // entity.other.attribute-name (rule entity)
			"attribute.value": "a5d6ff", // string.quoted.double.html (rule string)
			"attribute.value.number": "79c0ff", // constant.numeric (rule constant)
			"attribute.value.unit": "ff7b72", // keyword.other.unit (rule keyword)
			"delimiter.html": "e6edf3", // default foreground (no rule for punctuation.definition.tag)
			"delimiter.xml": "e6edf3", // default foreground (no rule for punctuation.definition.tag)
			"operator.sql": "ff7b72", // keyword.operator (rule keyword)
			"predefined.sql": "79c0ff", // support.function (rule support)
			identifier: "ffa657", // variable
			invalid: "ffa198", // invalid.illegal
		},
		fontStyles: {
			invalid: "italic", // invalid.illegal
		},
		colors: {
			"editor.background": "#0d1117",
			"editor.foreground": "#e6edf3",
			"editor.lineHighlightBackground": "#6e76811a",
			"editor.selectionHighlightBackground": "#3fb95040",
			"editorCursor.foreground": "#2f81f7",
			"editorLineNumber.foreground": "#6e7681",
			"editorLineNumber.activeForeground": "#e6edf3",
			"editorIndentGuide.background1": "#e6edf31f",
			"editorIndentGuide.activeBackground1": "#e6edf33d",
			"editorWidget.background": "#161b22",
			"textLink.foreground": "#2f81f7",
			"textLink.activeForeground": "#2f81f7",
			"scrollbarSlider.background": "#8b949e33",
			"scrollbarSlider.hoverBackground": "#8b949e3d",
			"scrollbarSlider.activeBackground": "#8b949e47",
			"scrollbar.shadow": "#484f5833",
			"editorBracketHighlight.foreground1": "#79c0ff",
			"editorBracketHighlight.foreground2": "#56d364",
			"editorBracketHighlight.foreground3": "#e3b341",
			"editorBracketHighlight.foreground4": "#ffa198",
			"editorBracketHighlight.foreground5": "#ff9bce",
			"editorBracketHighlight.foreground6": "#d2a8ff",
			"editorBracketHighlight.unexpectedBracket.foreground": "#7d8590",
		},
	},
};
