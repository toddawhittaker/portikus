import type * as Monaco from "monaco-editor";
import { expect, test, vi } from "vitest";
import {
	accessibilitySupport,
	baseEditorOptions,
	currentThemeName,
	editorAriaLabel,
	fenceLanguage,
	onThemeChange,
} from "./monaco.js";
import { setEditorScheme } from "./schemes/active.js";

vi.mock("./features.js", () => ({ loadEditorFeatures: async () => {} }));

/** SPEC.md §13.2: a scrollbar with change and problem marks, not a minimap. */
test("every editor marks changes and problems in the scrollbar, with no minimap", () => {
	expect(baseEditorOptions.minimap?.enabled).toBe(false);
	expect(baseEditorOptions.overviewRulerLanes).toBe(3);
});

/**
 * "off" would make Monaco name its text box "The editor is not accessible at
 * this time." and drop the file name, so the setting's off is "auto"
 * (SPEC.md §25.8).
 */
test("screen-reader mode forces support on, and off leaves it to Monaco", () => {
	expect(accessibilitySupport(true)).toBe("on");
	expect(accessibilitySupport(false)).toBe("auto");
});

test("the editor's name says which file and how Tab leaves it", () => {
	expect(editorAriaLabel("Editor", "src/app.ts")).toBe(
		"Editor, src/app.ts. Ctrl+M makes Tab leave the editor.",
	);
});

/** Monaco binds the toggle to Ctrl+Shift+M on macOS. */
test("on a Mac the editor's name gives the Mac key", () => {
	expect(editorAriaLabel("Editor", "src/app.ts", "mac")).toBe(
		"Editor, src/app.ts. Ctrl+Shift+M makes Tab leave the editor.",
	);
	expect(editorAriaLabel("Editor", "src/app.ts", "other")).toBe(
		"Editor, src/app.ts. Ctrl+M makes Tab leave the editor.",
	);
});

/** Monaco's language table, as far as fenceLanguage reads it. */
const languages = {
	languages: {
		getLanguages: () => [
			{
				id: "javascript",
				aliases: ["JavaScript", "javascript", "js"],
				extensions: [".js"],
			},
			{ id: "shell", aliases: ["Shell", "sh"], extensions: [".sh", ".bash"] },
			{ id: "python", aliases: ["Python", "py"], extensions: [".py"] },
		],
	},
} as unknown as typeof Monaco;

test("a fence finds its language by id, alias or extension, in any case", () => {
	expect(fenceLanguage(languages, "javascript")).toBe("javascript");
	expect(fenceLanguage(languages, "JS")).toBe("javascript");
	expect(fenceLanguage(languages, "Python")).toBe("python");
	expect(fenceLanguage(languages, "bash")).toBe("shell");
});

test("a fence naming no known language is left plain", () => {
	expect(fenceLanguage(languages, "mermaid")).toBeNull();
	expect(fenceLanguage(languages, "")).toBeNull();
});

/** The theme is the chosen scheme in the page's light or dark half. */
test("the theme name follows the scheme and the page's appearance", () => {
	const root = document.documentElement;
	try {
		root.setAttribute("data-theme", "dark");
		setEditorScheme("portikus");
		expect(currentThemeName()).toBe("portikus-portikus-dark");
		setEditorScheme("vscode");
		expect(currentThemeName()).toBe("portikus-vscode-dark");
		root.setAttribute("data-theme", "light");
		expect(currentThemeName()).toBe("portikus-vscode-light");
	} finally {
		root.removeAttribute("data-theme");
		setEditorScheme("portikus");
	}
});

test("changing the scheme calls the theme watchers, and stopping them silences them", () => {
	let calls = 0;
	const stop = onThemeChange(() => {
		calls += 1;
	});
	setEditorScheme("vscode");
	expect(calls).toBe(1);
	// The same scheme again changes nothing.
	setEditorScheme("vscode");
	expect(calls).toBe(1);
	stop();
	setEditorScheme("portikus");
	expect(calls).toBe(1);
});
