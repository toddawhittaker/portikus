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

test("Settings lists the seven schemes in the agreed order, with their labels", () => {
	expect(EDITOR_SCHEME_LIST.map((scheme) => scheme.label)).toEqual([
		"Portikus",
		"VS Code",
		"IntelliJ",
		"GitHub",
		"Solarized",
		"Catppuccin",
		"High contrast",
	]);
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

/**
 * A reference scheme copies what its source publishes and leaves the rest to
 * Monaco's base theme, so only the two colours every source can be expected to
 * hold are required, and a scheme whose source leaves even those to its base
 * says so here.
 */
const LEFT_TO_BASE = new Set(["high-contrast light"]);

test.each(MODES)(
	"every scheme defines the editor ground and text colours in %s",
	(mode) => {
		for (const scheme of EDITOR_SCHEME_LIST) {
			if (LEFT_TO_BASE.has(`${scheme.id} ${mode}`)) continue;
			const colors = scheme[mode].colors;
			for (const key of ["editor.background", "editor.foreground"]) {
				expect(colors[key], `${scheme.id} ${key}`).toMatch(COLOUR);
			}
		}
	},
);

test.each(MODES)("every editor colour a scheme sets is a hex colour in %s", (mode) => {
	for (const scheme of EDITOR_SCHEME_LIST) {
		for (const [key, colour] of Object.entries(scheme[mode].colors)) {
			expect(colour, `${scheme.id} ${key}`).toMatch(COLOUR);
		}
	}
});

test.each(MODES)("a scheme's font styles name token ids it defines, in %s", (mode) => {
	for (const scheme of EDITOR_SCHEME_LIST) {
		const half = scheme[mode];
		for (const [token, style] of Object.entries(half.fontStyles ?? {})) {
			expect(Object.keys(half.tokens), `${scheme.id} ${token}`).toContain(token);
			expect(["italic", "bold", "italic bold"]).toContain(style);
		}
	}
});

/** Portikus keeps its italic comments; VS Code's source has none. */
test("comments are italic in Portikus and carry no style in VS Code Modern", () => {
	for (const mode of MODES) {
		expect(PORTIKUS[mode].fontStyles?.comment).toBe("italic");
		expect(PORTIKUS[mode].fontStyles?.["comment.doc"]).toBe("italic");
		expect(schemeById("vscode")[mode].fontStyles).toBeUndefined();
	}
});

test("each mode inherits the Monaco base that matches its appearance", () => {
	for (const scheme of EDITOR_SCHEME_LIST) {
		// High contrast is the one scheme that takes Monaco's high contrast bases.
		const high = scheme.id === "high-contrast";
		expect(scheme.light.base, scheme.id).toBe(high ? "hc-light" : "vs");
		expect(scheme.dark.base, scheme.id).toBe(high ? "hc-black" : "vs-dark");
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
