import { expect, test } from "vitest";
import { PORTIKUS } from "./portikus.js";

function luminance(hex: string): number {
	const [r, g, b] = [0, 2, 4].map((at) => {
		const c = Number.parseInt(hex.slice(at, at + 2), 16) / 255;
		return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
	});
	return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
}

function contrast(a: string, b: string): number {
	const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
	return ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05);
}

const bare = (colour: string | undefined) => (colour ?? "").slice(1);

/** The editor background and line highlight of each Portikus theme. */
const BACKGROUNDS = {
	light: [
		bare(PORTIKUS.light.colors["editor.background"]),
		bare(PORTIKUS.light.colors["editor.lineHighlightBackground"]),
	],
	dark: [
		bare(PORTIKUS.dark.colors["editor.background"]),
		bare(PORTIKUS.dark.colors["editor.lineHighlightBackground"]),
	],
};

/** The bracket colours of a Portikus half, hex with no '#'. */
function brackets(mode: "light" | "dark"): Record<string, string> {
	return Object.fromEntries(
		Object.entries(PORTIKUS[mode].colors)
			.filter(([id]) => id.startsWith("editorBracketHighlight."))
			.map(([id, colour]) => [id, bare(colour)]),
	);
}

// Only Portikus is held to the floor; the reference schemes are copied as published.
test.each([
	["light", PORTIKUS.light.tokens, BACKGROUNDS.light],
	["dark", PORTIKUS.dark.tokens, BACKGROUNDS.dark],
] as const)(
	"every Portikus %s token colour reads at 4.5:1 or better (SPEC.md 25.8)",
	(_, tokens, backgrounds) => {
		for (const [token, colour] of Object.entries(tokens)) {
			for (const background of backgrounds) {
				expect(
					contrast(colour, background),
					`${token} on #${background}`,
				).toBeGreaterThanOrEqual(4.5);
			}
		}
	},
);

test.each([
	["light", BACKGROUNDS.light],
	["dark", BACKGROUNDS.dark],
] as const)(
	"every Portikus %s bracket colour reads at 4.5:1 or better (SPEC.md 25.8)",
	(mode, backgrounds) => {
		const colours = brackets(mode);
		expect(Object.keys(colours)).toHaveLength(4);
		for (const [id, colour] of Object.entries(colours)) {
			for (const background of backgrounds) {
				expect(
					contrast(colour, background),
					`${id} on #${background}`,
				).toBeGreaterThanOrEqual(4.5);
			}
		}
	},
);

test("Portikus sets comments, doc comments included, in italic in both modes", () => {
	for (const mode of [PORTIKUS.light, PORTIKUS.dark]) {
		expect(mode.fontStyles).toEqual({ comment: "italic", "comment.doc": "italic" });
	}
});
