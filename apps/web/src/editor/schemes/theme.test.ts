import { EDITOR_SCHEMES } from "@portikus/contracts";
import { expect, test } from "vitest";
import { EDITOR_SCHEME_LIST } from "./index.js";
import { OVERVIEW_RULER_COLOURS } from "./overviewRuler.js";
import { themeData, themeName } from "./theme.js";

test("a theme is named for its scheme and its half", () => {
	expect(themeName("portikus", "light")).toBe("portikus-portikus-light");
	expect(themeName("vscode", "dark")).toBe("portikus-vscode-dark");
});

test("every scheme and half has its own theme name", () => {
	const names = EDITOR_SCHEMES.flatMap((id) => [
		themeName(id, "light"),
		themeName(id, "dark"),
	]);
	expect(new Set(names).size).toBe(EDITOR_SCHEMES.length * 2);
});

/** Git and problem marks must match the Changes pane, whatever scheme is chosen. */
test.each(["light", "dark"] as const)(
	"every scheme's %s theme carries Portikus's overview-ruler colours",
	(mode) => {
		for (const scheme of EDITOR_SCHEME_LIST) {
			const { colors } = themeData(scheme, mode);
			for (const [key, colour] of Object.entries(OVERVIEW_RULER_COLOURS[mode])) {
				expect(colors[key], `${scheme.id} ${key}`).toBe(colour);
			}
		}
	},
);

test("the overview-ruler colours are the Git and status colours of theme.css", () => {
	expect(OVERVIEW_RULER_COLOURS.light["editorOverviewRuler.addedForeground"]).toBe(
		"#2b7336",
	);
	expect(OVERVIEW_RULER_COLOURS.dark["editorOverviewRuler.errorForeground"]).toBe(
		"#f59a8e",
	);
});

test("a theme inherits its base and gives each token its colour, comments in italic", () => {
	const scheme = EDITOR_SCHEME_LIST[0];
	if (!scheme) throw new Error("no schemes");
	const data = themeData(scheme, "dark");
	expect(data.base).toBe("vs-dark");
	expect(data.inherit).toBe(true);
	expect(data.rules.find((rule) => rule.token === "keyword")).toEqual({
		token: "keyword",
		foreground: scheme.dark.tokens.keyword,
	});
	expect(data.rules.find((rule) => rule.token === "comment")?.fontStyle).toBe("italic");
	expect(data.rules.find((rule) => rule.token === "string")?.fontStyle).toBeUndefined();
});
