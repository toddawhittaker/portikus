import type { Appearance } from "@portikus/contracts";

/**
 * Appearance: the theme follows the operating system unless the person picks
 * one in Settings (design/system/README.md, "Colour"). The choice is a
 * per-user setting (issue #300, SPEC.md §13.5). This browser keeps a copy
 * under `pk-theme` so the first paint, and the sign-in page, use it before
 * the settings arrive. Some browsers refuse storage, so every access is
 * guarded.
 */
export type ThemePreference = Appearance;

const STORAGE_KEY = "pk-theme";

export function readThemePreference(): ThemePreference {
	try {
		const stored = localStorage.getItem(STORAGE_KEY);
		if (stored === "light" || stored === "dark" || stored === "system") return stored;
	} catch {
		// No storage available; the operating system decides.
	}
	return "system";
}

/** Sets or clears `data-theme` on <html>; theme.css does the rest. */
export function applyThemePreference(preference: ThemePreference): void {
	const root = document.documentElement;
	if (preference === "system") {
		root.removeAttribute("data-theme");
	} else {
		root.setAttribute("data-theme", preference);
	}
}

/** Apply a choice and remember it in this browser for the next first paint. */
export function rememberThemePreference(preference: ThemePreference): void {
	applyThemePreference(preference);
	try {
		localStorage.setItem(STORAGE_KEY, preference);
	} catch {
		// The choice still applies to this page.
	}
}
