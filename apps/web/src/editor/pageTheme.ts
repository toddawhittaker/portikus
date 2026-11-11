import { useSyncExternalStore } from "react";

/** Whether the page is showing its dark theme right now (shell/theme.ts). */
export function pageIsDark(): boolean {
	const chosen = document.documentElement.getAttribute("data-theme");
	if (chosen === "dark") return true;
	if (chosen === "light") return false;
	return (
		typeof matchMedia === "function" &&
		matchMedia("(prefers-color-scheme: dark)").matches
	);
}

/** Call back whenever the page's light or dark choice may have changed. */
export function onThemeChange(callback: () => void): () => void {
	const observer = new MutationObserver(callback);
	observer.observe(document.documentElement, {
		attributes: true,
		attributeFilter: ["data-theme"],
	});
	const media =
		typeof matchMedia === "function"
			? matchMedia("(prefers-color-scheme: dark)")
			: null;
	media?.addEventListener("change", callback);
	return () => {
		observer.disconnect();
		media?.removeEventListener("change", callback);
	};
}

/** The page's theme, kept current as the student or the system changes it. */
export function usePageTheme(): "light" | "dark" {
	return useSyncExternalStore(onThemeChange, () => (pageIsDark() ? "dark" : "light"));
}
