import type * as Monaco from "monaco-editor";
import { expect, test, vi } from "vitest";
import { accessibilitySupport, editorAriaLabel, fenceLanguage } from "./monaco.js";

vi.mock("./features.js", () => ({ loadEditorFeatures: async () => {} }));

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
