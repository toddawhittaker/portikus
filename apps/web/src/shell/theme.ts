import { useCallback, useEffect, useState } from "react";

/**
 * Appearance: the theme follows the operating system unless the person picks
 * one in Settings (design/system/README.md, "Colour"). The choice is
 * remembered in this browser under `pk-theme`, which some browsers refuse,
 * so every access is guarded. It is not a server setting.
 */
export type ThemePreference = "system" | "light" | "dark";

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

export function useThemePreference(): [
	ThemePreference,
	(next: ThemePreference) => void,
] {
	const [preference, setPreference] = useState<ThemePreference>(readThemePreference);

	useEffect(() => {
		applyThemePreference(preference);
	}, [preference]);

	const choose = useCallback((next: ThemePreference) => {
		setPreference(next);
		try {
			localStorage.setItem(STORAGE_KEY, next);
		} catch {
			// The choice still applies to this page.
		}
	}, []);

	return [preference, choose];
}
