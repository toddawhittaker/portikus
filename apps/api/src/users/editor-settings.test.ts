import { EDITOR_SETTINGS_DEFAULTS, MAX_PANE_ZOOMS } from "@portikus/contracts";
import { expect, test } from "vitest";
import { mergePaneZooms, toEditorSettings, toPaneZooms } from "./editor-settings.js";

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

test("pane zooms drop malformed stored entries", () => {
	expect(
		toPaneZooms({
			paneZooms: { a: [150, 1], b: [999, 1], c: "x", d: [120, "y"], "": [100, 1] },
		}),
	).toEqual({ a: 150 });
	expect(toPaneZooms(null)).toEqual({});
	expect(toPaneZooms({ paneZooms: 3 })).toEqual({});
});

test("merging pane zooms sets, forgets, and keeps only the newest", () => {
	const stored = {
		paneZooms: Object.fromEntries(
			Array.from({ length: MAX_PANE_ZOOMS }, (_, i) => [`k${i}`, [100, i]]),
		),
	};
	const merged = mergePaneZooms(stored, { k3: null, fresh: 140 }, 10_000);
	expect(Object.keys(merged)).toHaveLength(MAX_PANE_ZOOMS);
	expect(merged.fresh).toEqual([140, 10_000]);
	expect(merged.k3).toBeUndefined();
	expect(merged.k4).toBeDefined();
	const over = mergePaneZooms(stored, { a: 110, b: 120 }, 10_000);
	expect(Object.keys(over)).toHaveLength(MAX_PANE_ZOOMS);
	expect(over.k0).toBeUndefined();
	expect(over.k1).toBeUndefined();
	expect(over.a).toBeDefined();
});

test("a pane key of __proto__ is stored and read back as an ordinary entry", () => {
	const merged = mergePaneZooms(null, JSON.parse('{"__proto__": 150}'), 1);
	expect(Object.keys(merged)).toEqual(["__proto__"]);
	const stored = JSON.parse(JSON.stringify({ paneZooms: merged }));
	const zooms = toPaneZooms(stored);
	expect(Object.keys(zooms)).toEqual(["__proto__"]);
	expect(Object.entries(zooms)).toEqual([["__proto__", 150]]);
	expect(Object.getPrototypeOf(zooms)).toBeNull();
});
