import type { EditorScheme } from "./types.js";

/*!
 * IntelliJ Light and Darcula colour schemes, copied as published in
 * JetBrains/intellij-community (platform/platform-resources/src). The colours are
 * read from the XML scheme files and written in this file's format; no colour
 * is changed.
 *
 * Copyright (C) JetBrains s.r.o.
 *
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not
 * use these colours except in compliance with the License. You may obtain a
 * copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS, WITHOUT
 * WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the
 * License for the specific language governing permissions and limitations under
 * the License.
 *
 * This software includes code from IntelliJ IDEA
 * Copyright (C) JetBrains s.r.o.
 * https://www.jetbrains.com/idea/
 */
/**
 * IntelliJ Light and Darcula, copied as published. No colour is adjusted, so a student
 * who picks this scheme gets IntelliJ's contrast, which is weaker than Portikus's
 * (DESIGN.md section 11).
 *
 * Source: https://github.com/JetBrains/intellij-community/tree/a16c071cf2086885c5f769332a703097f6a0d0aa/platform/platform-resources/src
 * (commit a16c071cf2086885c5f769332a703097f6a0d0aa, 2026-11-13).
 *   IntelliJ Light: themes/Light.xml, whose parent scheme is Default.
 *   Darcula: the Darcula scheme of DefaultColorSchemesManager.xml, whose parent is Default.
 *   Default: the Default scheme of DefaultColorSchemesManager.xml.
 * Each scheme is resolved with its parent, a child overriding the parent, and an attribute
 * with a baseAttributes takes that attribute's values first. Hex values are read as numbers,
 * so "80808" is 080808.
 *
 * Each Monaco token id takes the colour of the IntelliJ attribute named beside it. Where the
 * scheme does not set an attribute, IntelliJ uses the attribute's fallback, which is read
 * from DefaultLanguageHighlighterColors.java and XmlHighlighterColors.java at the same
 * commit; a token id with no attribute, or one that sets no colour, takes the scheme's
 * default foreground (the TEXT attribute). Font styles come from the attribute's FONT_TYPE.
 * An editor colour the scheme does not define is left out, so Monaco's base theme supplies
 * it. IntelliJ draws a bad character with a red underline and no text colour, so the
 * invalid token id takes the default foreground; the underline has no equivalent here.
 */
export const INTELLIJ: EditorScheme = {
	id: "intellij",
	label: "IntelliJ",
	source: {
		name: "IntelliJ Light and Darcula, from JetBrains/intellij-community",
		url: "https://github.com/JetBrains/intellij-community/tree/a16c071cf2086885c5f769332a703097f6a0d0aa/platform/platform-resources/src",
		licence: "Apache-2.0",
	},
	light: {
		base: "vs",
		tokens: {
			keyword: "0033b3", // DEFAULT_KEYWORD
			"keyword.flow": "0033b3", // DEFAULT_KEYWORD
			"keyword.control": "0033b3", // DEFAULT_KEYWORD
			"variable.predefined": "0033b3", // DEFAULT_KEYWORD
			string: "067d17", // DEFAULT_STRING
			"string.escape": "0037a6", // DEFAULT_VALID_STRING_ESCAPE
			"string.sql": "067d17", // DEFAULT_STRING
			"string.key.json": "871094", // DEFAULT_INSTANCE_FIELD (fallback of JSON.PROPERTY_KEY)
			"string.value.json": "067d17", // DEFAULT_STRING
			regexp: "264eff", // JS.REGEXP
			comment: "8c8c8c", // DEFAULT_LINE_COMMENT
			"comment.doc": "8c8c8c", // DEFAULT_DOC_COMMENT
			number: "1750eb", // DEFAULT_NUMBER
			"number.hex": "1750eb", // DEFAULT_NUMBER
			constant: "871094", // DEFAULT_CONSTANT
			type: "000000", // DEFAULT_IDENTIFIER (fallback of DEFAULT_CLASS_NAME)
			"type.identifier": "000000", // DEFAULT_IDENTIFIER (fallback of DEFAULT_CLASS_NAME)
			annotation: "9e880d", // DEFAULT_METADATA
			tag: "0033b3", // DEFAULT_KEYWORD (fallback of HTML_TAG_NAME)
			"tag.id.pug": "080808", // default foreground (IntelliJ sets no attribute for this)
			"tag.class.pug": "080808", // default foreground (IntelliJ sets no attribute for this)
			metatag: "080808", // default foreground (XML_PROLOGUE sets no colour)
			"metatag.content.html": "080808", // default foreground (XML_PROLOGUE sets no colour)
			"metatag.html": "080808", // default foreground (XML_PROLOGUE sets no colour)
			"metatag.xml": "080808", // default foreground (XML_PROLOGUE sets no colour)
			"attribute.name": "174ad4", // DEFAULT_ATTRIBUTE (fallback of HTML_ATTRIBUTE_NAME)
			"attribute.value": "067d17", // DEFAULT_STRING (fallback of HTML_ATTRIBUTE_VALUE)
			"attribute.value.number": "1750eb", // DEFAULT_NUMBER
			"attribute.value.unit": "1750eb", // DEFAULT_NUMBER
			"delimiter.html": "080808", // default foreground (HTML_TAG)
			"delimiter.xml": "080808", // default foreground (XML_TAG)
			"operator.sql": "080808", // default foreground (DEFAULT_OPERATION_SIGN)
			"predefined.sql": "080808", // default foreground (DEFAULT_PREDEFINED_SYMBOL sets no colour)
			identifier: "000000", // DEFAULT_IDENTIFIER
			invalid: "080808", // default foreground (BAD_CHARACTER sets no colour)
		},
		fontStyles: {
			comment: "italic", // DEFAULT_LINE_COMMENT
			"comment.doc": "italic", // DEFAULT_DOC_COMMENT
			constant: "italic", // DEFAULT_CONSTANT
			metatag: "italic", // XML_PROLOGUE
			"metatag.content.html": "italic", // XML_PROLOGUE
			"metatag.html": "italic", // XML_PROLOGUE
			"metatag.xml": "italic", // XML_PROLOGUE
			"predefined.sql": "italic", // DEFAULT_PREDEFINED_SYMBOL
		},
		colors: {
			"editor.background": "#ffffff", // TEXT background
			"editor.foreground": "#080808", // TEXT foreground
			"editor.lineHighlightBackground": "#fcfaed", // CARET_ROW_COLOR
			"editor.selectionBackground": "#a6d2ff", // SELECTION_BACKGROUND
			"editorCursor.foreground": "#000000", // CARET_COLOR
			"editorLineNumber.foreground": "#adadad", // LINE_NUMBERS_COLOR
			"editorIndentGuide.background1": "#e6e6e6", // INDENT_GUIDE
			"editorIndentGuide.activeBackground1": "#c8c8c8", // SELECTED_INDENT_GUIDE
		},
	},
	dark: {
		base: "vs-dark",
		tokens: {
			keyword: "cc7832", // DEFAULT_KEYWORD
			"keyword.flow": "cc7832", // DEFAULT_KEYWORD
			"keyword.control": "cc7832", // DEFAULT_KEYWORD
			"variable.predefined": "cc7832", // DEFAULT_KEYWORD
			string: "6a8759", // DEFAULT_STRING
			"string.escape": "cc7832", // DEFAULT_VALID_STRING_ESCAPE
			"string.sql": "6a8759", // DEFAULT_STRING
			"string.key.json": "9876aa", // DEFAULT_INSTANCE_FIELD (fallback of JSON.PROPERTY_KEY)
			"string.value.json": "6a8759", // DEFAULT_STRING
			regexp: "a9b7c6", // default foreground (JS.REGEXP)
			comment: "808080", // DEFAULT_LINE_COMMENT
			"comment.doc": "629755", // DEFAULT_DOC_COMMENT
			number: "6897bb", // DEFAULT_NUMBER
			"number.hex": "6897bb", // DEFAULT_NUMBER
			constant: "9876aa", // DEFAULT_CONSTANT
			type: "a9b7c6", // DEFAULT_IDENTIFIER (fallback of DEFAULT_CLASS_NAME)
			"type.identifier": "a9b7c6", // DEFAULT_IDENTIFIER (fallback of DEFAULT_CLASS_NAME)
			annotation: "bbb529", // DEFAULT_METADATA
			tag: "e8bf6a", // HTML_TAG_NAME
			"tag.id.pug": "a9b7c6", // default foreground (IntelliJ sets no attribute for this)
			"tag.class.pug": "a9b7c6", // default foreground (IntelliJ sets no attribute for this)
			metatag: "e8bf6a", // XML_PROLOGUE
			"metatag.content.html": "e8bf6a", // XML_PROLOGUE
			"metatag.html": "e8bf6a", // XML_PROLOGUE
			"metatag.xml": "e8bf6a", // XML_PROLOGUE
			"attribute.name": "bababa", // HTML_ATTRIBUTE_NAME
			"attribute.value": "a5c261", // HTML_ATTRIBUTE_VALUE
			"attribute.value.number": "6897bb", // DEFAULT_NUMBER
			"attribute.value.unit": "6897bb", // DEFAULT_NUMBER
			"delimiter.html": "e8bf6a", // HTML_TAG
			"delimiter.xml": "e8bf6a", // XML_TAG
			"operator.sql": "a9b7c6", // default foreground (DEFAULT_OPERATION_SIGN)
			"predefined.sql": "a9b7c6", // default foreground (DEFAULT_PREDEFINED_SYMBOL sets no colour)
			identifier: "a9b7c6", // DEFAULT_IDENTIFIER
			invalid: "a9b7c6", // default foreground (BAD_CHARACTER sets no colour)
		},
		fontStyles: {
			"comment.doc": "italic", // DEFAULT_DOC_COMMENT
			constant: "italic", // DEFAULT_CONSTANT
			"predefined.sql": "italic", // DEFAULT_PREDEFINED_SYMBOL
		},
		colors: {
			"editor.background": "#2b2b2b", // TEXT background
			"editor.foreground": "#a9b7c6", // TEXT foreground
			"editor.lineHighlightBackground": "#323232", // CARET_ROW_COLOR
			"editor.selectionBackground": "#214283", // SELECTION_BACKGROUND
			"editorCursor.foreground": "#bbbbbb", // CARET_COLOR
			"editorLineNumber.foreground": "#606366", // LINE_NUMBERS_COLOR
			"editorLineNumber.activeForeground": "#a4a3a3", // LINE_NUMBER_ON_CARET_ROW_COLOR
			"editorIndentGuide.background1": "#373737", // INDENT_GUIDE
			"editorIndentGuide.activeBackground1": "#505050", // SELECTED_INDENT_GUIDE
		},
	},
};
