import { EDITOR_SCHEMES } from "@portikus/contracts";
import { expect, test } from "vitest";
import { EDITOR_SCHEME_LIST, schemeById } from "./index.js";
import { PORTIKUS } from "./portikus.js";

const MODES = ["light", "dark"] as const;
const HEX = /^[0-9a-fA-F]{6}$/;
const COLOUR = /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/;

test("the list holds one scheme for every id the contract allows, in the contract's order", () => {
	expect(EDITOR_SCHEME_LIST.map((scheme) => scheme.id)).toEqual([...EDITOR_SCHEMES]);
});

test("every scheme has a label, and Portikus is first and plain", () => {
	for (const scheme of EDITOR_SCHEME_LIST) expect(scheme.label).not.toBe("");
	expect(EDITOR_SCHEME_LIST[0]?.id).toBe("portikus");
	expect(PORTIKUS.label).toBe("Portikus");
	expect(schemeById("vscode").label).toBe("VS Code");
});

test("a scheme that is not Portikus's own names its source and licence", () => {
	for (const scheme of EDITOR_SCHEME_LIST) {
		if (scheme.id === "portikus") continue;
		expect(scheme.source?.url).toMatch(/^https:\/\//);
		expect(scheme.source?.licence).not.toBe("");
	}
});

test.each(MODES)("every scheme defines all the Portikus token ids in %s", (mode) => {
	const wanted = Object.keys(PORTIKUS[mode].tokens).sort();
	for (const scheme of EDITOR_SCHEME_LIST) {
		const tokens = scheme[mode].tokens;
		// No scheme adds a token id of its own.
		expect(Object.keys(tokens).sort(), scheme.id).toEqual(wanted);
		for (const colour of Object.values(tokens)) expect(colour).toMatch(HEX);
	}
});

test.each(MODES)("every scheme defines the core editor colours in %s", (mode) => {
	for (const scheme of EDITOR_SCHEME_LIST) {
		const colors = scheme[mode].colors;
		for (const key of [
			"editor.background",
			"editor.foreground",
			"editorLineNumber.foreground",
			"editorLineNumber.activeForeground",
			"editorIndentGuide.background1",
			"editorWidget.background",
			"textLink.foreground",
		]) {
			expect(colors[key], `${scheme.id} ${key}`).toMatch(COLOUR);
		}
	}
});

test("each mode inherits the Monaco base that matches its appearance", () => {
	for (const scheme of EDITOR_SCHEME_LIST) {
		expect(scheme.light.base, scheme.id).toBe("vs");
		expect(scheme.dark.base, scheme.id).toBe("vs-dark");
	}
});

test("no scheme sets overview-ruler colours of its own", () => {
	for (const scheme of EDITOR_SCHEME_LIST) {
		for (const mode of MODES) {
			const keys = Object.keys(scheme[mode].colors);
			expect(keys.filter((key) => key.startsWith("editorOverviewRuler."))).toEqual([]);
		}
	}
});
