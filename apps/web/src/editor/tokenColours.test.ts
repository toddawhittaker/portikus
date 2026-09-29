import { expect, test } from "vitest";
import { DARK_TOKENS, LIGHT_TOKENS } from "./tokenColours.js";

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

// The editor background and line highlight of each theme in monaco.ts.
const BACKGROUNDS = {
	light: ["f6f4ef", "eeebe4"],
	dark: ["171614", "211f1c"],
};

test.each([
	["light", LIGHT_TOKENS, BACKGROUNDS.light],
	["dark", DARK_TOKENS, BACKGROUNDS.dark],
] as const)(
	"every %s token colour reads at 4.5:1 or better (SPEC.md 25.8)",
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
