/**
 * Move focus to a field after its error has rendered, so a screen reader
 * reads the label with the new error. Blurring first makes an
 * already-focused field announce again.
 */
export function focusField(id: string): void {
	const input = document.getElementById(id);
	input?.blur();
	input?.focus();
}
