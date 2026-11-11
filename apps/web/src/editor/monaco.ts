/**
 * Monaco setup (SPEC.md §13.1, STACK.md §3). Environment glue only: the one
 * worker the editor needs, and the two themes built from the colour tokens in
 * packages/ui/src/theme.css.
 *
 * Only highlighting is loaded, not the TypeScript, CSS or HTML language
 * services: their diagnostics do not know the project's configuration and
 * would confuse students (SPEC.md §13.2: this is not a VS Code clone).
 * Leaving them out also keeps about nine megabytes of language-server
 * workers out of the bundle. Code help comes instead from language servers
 * in the workspace, which do know it (SPEC.md §13.6, src/lsp).
 */
import type * as Monaco from "monaco-editor";
// Vite's `?worker` import: it bundles the worker and gives back a constructor.
// A bare `new URL(..., import.meta.url)` does not resolve a package specifier
// in this build.
import EditorWorker from "monaco-editor/editor/editor.worker.js?worker";
import JsonWorker from "monaco-editor/language/json/json.worker.js?worker";
import { currentPlatform, type Platform, tabFocusKey } from "../platform.js";
import { loadEditorFeatures } from "./features.js";
import { detectLanguage } from "./language.js";
import { onThemeChange, pageIsDark } from "./pageTheme.js";
import {
	DARK_BRACKETS,
	DARK_TOKENS,
	EDITOR_BACKGROUNDS,
	LIGHT_BRACKETS,
	LIGHT_TOKENS,
} from "./tokenColours.js";
import { BASE_FONT_SIZE } from "./zoom.js";

export { onThemeChange };

const environment: Monaco.Environment = {
	// JSON is the one language service kept, because JSON files are named in
	// SPEC.md §13.2; its diagnostics are turned off in getMonaco below.
	getWorker: (_id: string, label: string) =>
		label === "json" ? new JsonWorker() : new EditorWorker(),
};

(self as unknown as { MonacoEnvironment: Monaco.Environment }).MonacoEnvironment =
	environment;

/** The language id whose extension or file name matches this path. */
export function languageForPath(monaco: typeof Monaco, path: string): string {
	const name = path.split("/").pop() ?? path;
	const dot = name.lastIndexOf(".");
	const extension = dot > 0 ? name.slice(dot) : "";
	for (const language of monaco.languages.getLanguages()) {
		if (language.filenames?.includes(name)) return language.id;
	}
	if (extension === "") return "plaintext";
	for (const language of monaco.languages.getLanguages()) {
		if (language.extensions?.includes(extension)) return language.id;
	}
	return "plaintext";
}

/**
 * The language for a file, falling back to what its first line says when the
 * name and extension give nothing away (SPEC.md §13.2). A shell hook called
 * pre-applypatch.sample is highlighted as shell, not as plain text.
 */
export function languageForFile(
	monaco: typeof Monaco,
	path: string,
	firstLine: string,
): string {
	const byName = languageForPath(monaco, path);
	if (byName !== "plaintext") return byName;
	const name = path.split("/").pop() ?? path;
	const guess = detectLanguage(name, firstLine);
	if (guess === null) return "plaintext";
	// Only ids Monaco actually knows; the table names a few it may not load.
	const known = monaco.languages.getLanguages().some((l) => l.id === guess);
	return known ? guess : "plaintext";
}

/**
 * The language a Markdown fence names, by Monaco's ids, aliases or file
 * extensions, so `js`, `JavaScript` and `bash` all find a highlighter. An
 * unknown name gives null and the block stays plain.
 */
export function fenceLanguage(monaco: typeof Monaco, fence: string): string | null {
	const name = fence.toLowerCase();
	const languages = monaco.languages.getLanguages();
	const byName = languages.find(
		(language) =>
			language.id.toLowerCase() === name ||
			language.aliases?.some((alias) => alias.toLowerCase() === name),
	);
	if (byName) return byName.id;
	const byExtension = languages.find((language) =>
		language.extensions?.includes(`.${name}`),
	);
	return byExtension?.id ?? null;
}

/**
 * A fenced block's code as Monaco's highlighted HTML, in the theme the page
 * shows, or null when the fence names no language Monaco knows. The HTML is
 * not safe to insert as it is; highlight.ts rebuilds it (SPEC.md §24.3).
 */
export async function colorizeFence(
	code: string,
	fence: string,
): Promise<string | null> {
	const monaco = await getMonaco();
	const language = fenceLanguage(monaco, fence);
	if (language === null) return null;
	// The class names in the HTML index the colours of the theme set now.
	monaco.editor.setTheme(currentThemeName());
	return monaco.editor.colorize(code, language, { tabSize: 4 });
}

/**
 * The options every Portikus editor shares, so the file editor and the diff
 * editor cannot drift apart. Each editor adds its own theme and anything
 * particular to it.
 */
export const baseEditorOptions: Monaco.editor.IEditorOptions &
	Monaco.editor.IGlobalEditorOptions = {
	automaticLayout: true,
	fontFamily: '"JetBrains Mono", ui-monospace, monospace',
	fontSize: BASE_FONT_SIZE,
	// The stock Monaco reading aids are on (SPEC.md §13.2, DESIGN.md "The
	// editor"): folding, bracket pair colouring and bracket match. In place of
	// a minimap, the overview ruler in the scrollbar marks Git changes,
	// warnings, errors and find matches.
	minimap: { enabled: false },
	overviewRulerBorder: false,
	overviewRulerLanes: 3,
	hideCursorInOverviewRuler: true,
	scrollbar: {
		verticalScrollbarSize: 12,
		horizontalScrollbarSize: 10,
		useShadows: false,
	},
	folding: true,
	bracketPairColorization: { enabled: true },
	matchBrackets: "always",
	// Portikus does its own Ctrl+wheel zoom per editor, so Monaco's global one
	// stays off (CodeEditor.tsx).
	mouseWheelZoom: false,
	scrollBeyondLastLine: false,
	// Every suggestion comes from a language server (SPEC.md §13.6).
	wordBasedSuggestions: "off",
	// A peek needs the other file's model, which only exists once it is a tab.
	gotoLocation: { multiple: "goto" },
};

/**
 * Monaco's screen-reader support follows the student's setting. With the
 * setting off this is "auto", not "off": "off" makes Monaco name its text box
 * "The editor is not accessible at this time." and drop the file name
 * (SPEC.md §25.8).
 */
export function accessibilitySupport(screenReaderMode: boolean): "on" | "auto" {
	return screenReaderMode ? "on" : "auto";
}

/**
 * The accessible name of an editor's text box: what it is, which file, and how
 * to make Tab leave it (Monaco's tab-focus toggle, SPEC.md §25.8).
 */
export function editorAriaLabel(
	kind: string,
	path: string,
	platform: Platform = currentPlatform(),
): string {
	return `${kind}, ${path}. ${tabFocusKey(platform)} makes Tab leave the editor.`;
}

const LIGHT_THEME = "portikus-light";
const DARK_THEME = "portikus-dark";

function tokenRules(colours: Record<string, string>): Monaco.editor.ITokenThemeRule[] {
	// Comments are set in italic as well, so they read as asides without relying on colour.
	return Object.entries(colours).map(([token, foreground]) =>
		token.startsWith("comment")
			? { token, foreground, fontStyle: "italic" }
			: { token, foreground },
	);
}

function withHash(colours: Record<string, string>): Record<string, string> {
	return Object.fromEntries(
		Object.entries(colours).map(([id, hex]) => [id, `#${hex}`]),
	);
}

function defineThemes(monaco: typeof Monaco): void {
	monaco.editor.defineTheme(LIGHT_THEME, {
		base: "vs",
		inherit: true,
		rules: tokenRules(LIGHT_TOKENS),
		colors: {
			"editor.background": `#${EDITOR_BACKGROUNDS.light.ground}`,
			"editor.foreground": "#221f1a",
			"editor.lineHighlightBackground": `#${EDITOR_BACKGROUNDS.light.line}`,
			"editor.selectionBackground": "#cce9e2",
			"editorCursor.foreground": "#1d6e67",
			"editorLineNumber.foreground": "#675f53",
			"editorLineNumber.activeForeground": "#221f1a",
			"editorIndentGuide.background1": "#e2dacb",
			"editorWidget.background": "#ffffff",
			// Links in code help's hover, such as View Problem, in the accent.
			"textLink.foreground": "#17625b",
			"textLink.activeForeground": "#10443f",
			"editorWidget.border": "#e2dacb",
			// The split view's code side needs a scrollbar a student can see
			// against a pale background.
			"scrollbarSlider.background": "#c1b9a8cc",
			"scrollbarSlider.hoverBackground": "#a89f8ce6",
			"scrollbarSlider.activeBackground": "#8d8472",
			"scrollbar.shadow": "#00000000",
			// The scrollbar's ticks: the Git and status colours of theme.css.
			"editorOverviewRuler.background": "#00000000",
			"editorOverviewRuler.border": "#00000000",
			"editorOverviewRuler.modifiedForeground": "#8a5a00",
			"editorOverviewRuler.addedForeground": "#2b7336",
			"editorOverviewRuler.deletedForeground": "#b0372b",
			"editorOverviewRuler.warningForeground": "#8a5a00",
			"editorOverviewRuler.errorForeground": "#b0372b",
			"editorOverviewRuler.findMatchForeground": "#1d6e67",
			"editorOverviewRuler.selectionHighlightForeground": "#1d6e6780",
			"editorOverviewRuler.wordHighlightForeground": "#1d6e6780",
			"editorOverviewRuler.bracketMatchForeground": "#00000000",
			...withHash(LIGHT_BRACKETS),
		},
	});
	monaco.editor.defineTheme(DARK_THEME, {
		base: "vs-dark",
		inherit: true,
		rules: tokenRules(DARK_TOKENS),
		colors: {
			"editor.background": `#${EDITOR_BACKGROUNDS.dark.ground}`,
			"editor.foreground": "#f0ebe1",
			"editor.lineHighlightBackground": `#${EDITOR_BACKGROUNDS.dark.line}`,
			"editor.selectionBackground": "#183f3a",
			"editorCursor.foreground": "#5fcfbf",
			"editorLineNumber.foreground": "#aaa396",
			"editorLineNumber.activeForeground": "#f0ebe1",
			"editorIndentGuide.background1": "#2f2d29",
			"editorWidget.background": "#2a2825",
			"textLink.foreground": "#7fd9cc",
			"textLink.activeForeground": "#a6e8de",
			"editorWidget.border": "#36332e",
			"scrollbarSlider.background": "#4b473fcc",
			"scrollbarSlider.hoverBackground": "#615c52e6",
			"scrollbarSlider.activeBackground": "#7a7466",
			"scrollbar.shadow": "#00000000",
			"editorOverviewRuler.background": "#00000000",
			"editorOverviewRuler.border": "#00000000",
			"editorOverviewRuler.modifiedForeground": "#f2c35a",
			"editorOverviewRuler.addedForeground": "#7fd18a",
			"editorOverviewRuler.deletedForeground": "#f59a8e",
			"editorOverviewRuler.warningForeground": "#f2c35a",
			"editorOverviewRuler.errorForeground": "#f59a8e",
			"editorOverviewRuler.findMatchForeground": "#5fcfbf",
			"editorOverviewRuler.selectionHighlightForeground": "#5fcfbf80",
			"editorOverviewRuler.wordHighlightForeground": "#5fcfbf80",
			"editorOverviewRuler.bracketMatchForeground": "#00000000",
			...withHash(DARK_BRACKETS),
		},
	});
}

let loading: Promise<typeof Monaco> | null = null;

/** Load Monaco once, with the themes defined. Every caller shares the promise. */
export function getMonaco(): Promise<typeof Monaco> {
	loading ??= (async () => {
		const monaco = (await import(
			"monaco-editor/editor/editor.api.js"
		)) as unknown as typeof Monaco;
		await loadEditorFeatures(monaco);
		// Highlighting for the languages students write. JSON is the one
		// language with a service rather than a highlighter, because SPEC.md
		// §13.2 names it; it only checks JSON syntax and asks for no schemas.
		await import("monaco-editor/basic-languages/monaco.contribution.js");
		const json = await import("monaco-editor/language/json/monaco.contribution.js");
		// No schemas and no validation: a student's JSON is checked by the tool
		// that reads it, not by the editor guessing at a schema.
		json.jsonDefaults.setDiagnosticsOptions({
			validate: false,
			allowComments: true,
			schemas: [],
			enableSchemaRequest: false,
		});
		defineThemes(monaco);
		return monaco;
	})();
	return loading;
}

/** The theme name matching what the page is showing right now (shell/theme.ts). */
export function currentThemeName(): string {
	return pageIsDark() ? DARK_THEME : LIGHT_THEME;
}

let watching = false;

/**
 * Follow the page's light or dark choice. Monaco's theme is global, so one
 * watcher serves every editor rather than one subscription per editor.
 */
export function watchTheme(): void {
	if (watching) return;
	watching = true;
	onThemeChange(() => {
		void getMonaco().then((monaco) => monaco.editor.setTheme(currentThemeName()));
	});
}
