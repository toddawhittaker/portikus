import type { EditorScheme as EditorSchemeId } from "@portikus/contracts";
import type * as Monaco from "monaco-editor";
import { OVERVIEW_RULER_COLOURS } from "./overviewRuler.js";
import type { EditorScheme } from "./types.js";

/** The page's appearance, which picks the light or dark half of a scheme. */
export type PageMode = "light" | "dark";

/** The name a scheme's theme goes by in Monaco. */
export function themeName(id: EditorSchemeId, mode: PageMode): string {
	return `portikus-${id}-${mode}`;
}

/** Monaco's theme data for one half of a scheme, with the shared overview-ruler colours. */
export function themeData(
	scheme: EditorScheme,
	mode: PageMode,
): Monaco.editor.IStandaloneThemeData {
	const half = scheme[mode];
	return {
		base: half.base,
		inherit: true,
		rules: Object.entries(half.tokens).map(([token, foreground]) => {
			const fontStyle = half.fontStyles?.[token];
			return fontStyle ? { token, foreground, fontStyle } : { token, foreground };
		}),
		colors: { ...half.colors, ...OVERVIEW_RULER_COLOURS[mode] },
	};
}
