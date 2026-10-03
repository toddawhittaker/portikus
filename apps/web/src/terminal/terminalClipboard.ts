/**
 * What a key press in a terminal means for the clipboard (plan, "Clipboard in
 * the terminal"). Kept as one pure decision so the whole matrix can be tested
 * without a terminal or a browser clipboard.
 *
 * Ctrl+C is the one that matters: with a selection it copies, and with no
 * selection it must reach the shell as the interrupt.
 */
export type ClipboardAction = "copy" | "paste" | "passthrough";

export interface ClipboardKeyEvent {
	type: string;
	key: string;
	ctrlKey: boolean;
	shiftKey: boolean;
	altKey: boolean;
	metaKey: boolean;
}

/**
 * `platform` decides whether Command counts as Control. Pass "mac" on macOS;
 * anywhere else Meta is the window manager's key and is left alone.
 */
export function decide(
	event: ClipboardKeyEvent,
	hasSelection: boolean,
	platform: "mac" | "other" = "other",
): ClipboardAction {
	if (event.type !== "keydown") return "passthrough";
	if (event.altKey) return "passthrough";

	// On macOS Command does the same job as Control here.
	const modifier = event.ctrlKey || (platform === "mac" && event.metaKey);
	if (!modifier) return "passthrough";

	const key = event.key.toLowerCase();
	if (key === "c") {
		if (event.shiftKey) return "copy";
		return hasSelection ? "copy" : "passthrough";
	}
	if (key === "v") return "paste";
	return "passthrough";
}

/** True when this browser is on macOS, where Command carries the clipboard. */
export function currentPlatform(): "mac" | "other" {
	if (typeof navigator === "undefined") return "other";
	const value = `${navigator.platform ?? ""} ${navigator.userAgent ?? ""}`;
	return /mac/i.test(value) ? "mac" : "other";
}
