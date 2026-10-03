export type Platform = "mac" | "other";

/** True when this browser is on macOS, where some keys differ. */
export function currentPlatform(): Platform {
	if (typeof navigator === "undefined") return "other";
	const value = `${navigator.platform ?? ""} ${navigator.userAgent ?? ""}`;
	return /mac/i.test(value) ? "mac" : "other";
}

/**
 * The key for Monaco's tab-focus toggle. Monaco binds Ctrl+M, but on macOS
 * Ctrl+Shift+M, since Command+M minimises the window (SPEC.md §25.8).
 */
export function tabFocusKey(platform: Platform = currentPlatform()): string {
	return platform === "mac" ? "Ctrl+Shift+M" : "Ctrl+M";
}
