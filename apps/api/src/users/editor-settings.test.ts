import { EDITOR_SETTINGS_DEFAULTS } from "@portikus/contracts";
import { expect, test } from "vitest";
import { toEditorSettings } from "./editor-settings.js";

/** Stored settings are JSON, so a scheme a later build drops must not break the rest. */
test("an unknown stored editor scheme falls back to portikus and keeps the other settings", () => {
	const settings = toEditorSettings({ editorScheme: "monokai", wordWrap: false });
	expect(settings.editorScheme).toBe("portikus");
	expect(settings.wordWrap).toBe(false);
});

test("a settings row from before schemes existed gets the default scheme", () => {
	expect(toEditorSettings({ autoSave: false }).editorScheme).toBe(
		EDITOR_SETTINGS_DEFAULTS.editorScheme,
	);
});

test("a stored known scheme is kept", () => {
	expect(toEditorSettings({ editorScheme: "vscode" }).editorScheme).toBe("vscode");
});
