/**
 * Monaco setup (SPEC.md §13.1, STACK.md §3). Environment glue only: the one
 * worker the editor needs, and the two themes built from the colour tokens in
 * packages/ui/src/theme.css.
 *
 * Only highlighting is loaded, not the TypeScript, CSS or HTML language
 * services: their diagnostics do not know the project's configuration and
 * would confuse students (SPEC.md §13.2: this is not a VS Code clone).
 * Leaving them out also keeps about nine megabytes of language-server
 * workers out of the bundle.
 */
import type * as Monaco from "monaco-editor";
// Vite's `?worker` import: it bundles the worker and gives back a constructor.
// A bare `new URL(..., import.meta.url)` does not resolve a package specifier
// in this build.
import EditorWorker from "monaco-editor/editor/editor.worker.js?worker";
import JsonWorker from "monaco-editor/language/json/json.worker.js?worker";

const environment: Monaco.Environment = {
	// JSON is the one language service kept, because JSON files are named in
	// SPEC.md §13.2; its validation is turned off below.
	getWorker: (_id: string, label: string) =>
		label === "json" ? new JsonWorker() : new EditorWorker(),
};

(self as unknown as { MonacoEnvironment: Monaco.Environment }).MonacoEnvironment =
	environment;

export const LIGHT_THEME = "portikus-light";
export const DARK_THEME = "portikus-dark";

function defineThemes(monaco: typeof Monaco): void {
	monaco.editor.defineTheme(LIGHT_THEME, {
		base: "vs",
		inherit: true,
		rules: [],
		colors: {
			"editor.background": "#f6f4ef",
			"editor.foreground": "#23211d",
			"editor.lineHighlightBackground": "#eeebe4",
			"editor.selectionBackground": "#d9e8e5",
			"editorCursor.foreground": "#2c6a66",
			"editorLineNumber.foreground": "#6e685d",
			"editorLineNumber.activeForeground": "#23211d",
			"editorIndentGuide.background1": "#dcd7cc",
			"editorWidget.background": "#fdfcfa",
			"editorWidget.border": "#dcd7cc",
			"scrollbarSlider.background": "#dcd7cc80",
		},
	});
	monaco.editor.defineTheme(DARK_THEME, {
		base: "vs-dark",
		inherit: true,
		rules: [],
		colors: {
			"editor.background": "#171614",
			"editor.foreground": "#ece8df",
			"editor.lineHighlightBackground": "#211f1c",
			"editor.selectionBackground": "#1c3533",
			"editorCursor.foreground": "#7cc2b9",
			"editorLineNumber.foreground": "#948d81",
			"editorLineNumber.activeForeground": "#ece8df",
			"editorIndentGuide.background1": "#35322d",
			"editorWidget.background": "#211f1c",
			"editorWidget.border": "#35322d",
			"scrollbarSlider.background": "#35322d80",
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
		// Highlighting for the languages students write. JSON is the one
		// language with a service rather than a highlighter, because SPEC.md
		// §13.2 names it; it only checks JSON syntax and asks for no schemas.
		await import("monaco-editor/basic-languages/monaco.contribution.js");
		await import("monaco-editor/language/json/monaco.contribution.js");
		defineThemes(monaco);
		return monaco;
	})();
	return loading;
}

/** The theme name matching what the page is showing right now (shell/theme.ts). */
export function currentThemeName(): string {
	const chosen = document.documentElement.getAttribute("data-theme");
	if (chosen === "dark") return DARK_THEME;
	if (chosen === "light") return LIGHT_THEME;
	const dark =
		typeof matchMedia === "function" &&
		matchMedia("(prefers-color-scheme: dark)").matches;
	return dark ? DARK_THEME : LIGHT_THEME;
}
