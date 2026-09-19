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
import { loadEditorFeatures } from "./features.js";
import { detectLanguage } from "./language.js";
import { BASE_FONT_SIZE } from "./zoom.js";

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
 * The options every Portikus editor shares, so the file editor and the diff
 * editor cannot drift apart. Each editor adds its own theme and anything
 * particular to it.
 */
export const baseEditorOptions: Monaco.editor.IEditorOptions = {
	automaticLayout: true,
	fontFamily: '"JetBrains Mono", ui-monospace, monospace',
	fontSize: BASE_FONT_SIZE,
	// The stock Monaco reading aids are on (SPEC.md §13.2, DESIGN.md "The
	// editor"): minimap, folding, bracket pair colouring and bracket match.
	minimap: { enabled: true },
	folding: true,
	bracketPairColorization: { enabled: true },
	matchBrackets: "always",
	// Portikus does its own Ctrl+wheel zoom per editor, so Monaco's global one
	// stays off (CodeEditor.tsx).
	mouseWheelZoom: false,
	scrollBeyondLastLine: false,
};

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
			// The split view's code side needs a scrollbar a student can see
			// against a pale background (issue #154).
			"scrollbarSlider.background": "#c1b9a8cc",
			"scrollbarSlider.hoverBackground": "#a89f8ce6",
			"scrollbarSlider.activeBackground": "#8d8472",
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
			"scrollbarSlider.background": "#4b473fcc",
			"scrollbarSlider.hoverBackground": "#615c52e6",
			"scrollbarSlider.activeBackground": "#7a7466",
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
		await loadEditorFeatures();
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
	const chosen = document.documentElement.getAttribute("data-theme");
	if (chosen === "dark") return DARK_THEME;
	if (chosen === "light") return LIGHT_THEME;
	const dark =
		typeof matchMedia === "function" &&
		matchMedia("(prefers-color-scheme: dark)").matches;
	return dark ? DARK_THEME : LIGHT_THEME;
}

let watching = false;

/**
 * Follow the page's light or dark choice. Monaco's theme is global, so one
 * watcher serves every editor rather than one subscription per editor.
 */
export function watchTheme(): void {
	if (watching) return;
	watching = true;
	const apply = () => {
		void getMonaco().then((monaco) => monaco.editor.setTheme(currentThemeName()));
	};
	new MutationObserver(apply).observe(document.documentElement, {
		attributes: true,
		attributeFilter: ["data-theme"],
	});
	if (typeof matchMedia === "function") {
		matchMedia("(prefers-color-scheme: dark)").addEventListener("change", apply);
	}
}
