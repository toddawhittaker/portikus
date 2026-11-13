import { EDITOR_SETTINGS_DEFAULTS, type EditorScheme } from "@portikus/contracts";

/**
 * The scheme every editor on the page uses. Monaco's theme is global, so the
 * choice is too: one value here, set when the student's settings arrive or
 * change, and read by monaco.ts when it names the theme. Kept apart from
 * monaco.ts so the settings code can set it without loading the editor.
 */
let active: EditorScheme = EDITOR_SETTINGS_DEFAULTS.editorScheme;
const listeners = new Set<() => void>();

export function activeEditorScheme(): EditorScheme {
	return active;
}

/** Use this scheme from now on and tell every listener, unless it is already in use. */
export function setEditorScheme(id: EditorScheme): void {
	if (id === active) return;
	active = id;
	for (const listener of listeners) listener();
}

/** Call back when the scheme changes. Returns the function that stops it. */
export function onEditorSchemeChange(callback: () => void): () => void {
	listeners.add(callback);
	return () => {
		listeners.delete(callback);
	};
}
