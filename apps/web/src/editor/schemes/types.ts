import type { EditorScheme as EditorSchemeId } from "@portikus/contracts";

/** Monaco's four base themes; a scheme's colours are laid over one of them. */
type MonacoBase = "vs" | "vs-dark" | "hc-black" | "hc-light";

/** The font styles a scheme's source can ask for; Monaco reads "italic bold" as both. */
type TokenFontStyle = "italic" | "bold" | "italic bold";

/** One scheme in one page appearance: the light half or the dark half. */
export interface SchemeMode {
	/** The Monaco theme this mode inherits, so a colour the mode leaves out still has a value. */
	base: MonacoBase;
	/**
	 * Syntax colours: a Monaco token id to a hex colour with no '#'. Use only
	 * the token ids Portikus defines (schemes/portikus.ts); another scheme
	 * maps its source's scopes or attributes onto those ids.
	 */
	tokens: Record<string, string>;
	/**
	 * Font styles, a token id to the style the source gives that token. A token
	 * the source does not style is left out and draws in the regular weight.
	 */
	fontStyles?: Record<string, TokenFontStyle>;
	/**
	 * Editor colours: a Monaco colour key to '#rrggbb' or '#rrggbbaa'. Leave
	 * out any key the source does not define, so the base theme supplies it.
	 * Never include `editorOverviewRuler.*` keys: overviewRuler.ts adds the
	 * same ones to every scheme so Git and problem marks match the Changes pane.
	 */
	colors: Record<string, string>;
}

/** A named light and dark pair. The page's appearance picks the half. */
export interface EditorScheme {
	/** One of EDITOR_SCHEMES in packages/contracts/src/settings.ts. */
	id: EditorSchemeId;
	/** What Settings shows in the select. */
	label: string;
	/** Where the colours were copied from, for a scheme that is not Portikus's own. */
	source?: { name: string; url: string; licence: string };
	light: SchemeMode;
	dark: SchemeMode;
}
