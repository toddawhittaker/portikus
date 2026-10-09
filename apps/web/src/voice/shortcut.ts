/**
 * Alt+Shift+M, the hold-to-talk key wherever voice input is offered
 * (SPEC.md §25.10). The code, not the key: Alt changes the character on a Mac.
 */
export function isVoiceShortcut(event: KeyboardEvent): boolean {
	return event.altKey && event.shiftKey && event.code === "KeyM";
}

/** Whether releasing this key ends an Alt+Shift+M hold. */
export function endsVoiceShortcut(event: KeyboardEvent): boolean {
	return event.code === "KeyM" || event.key === "Alt" || event.key === "Shift";
}
