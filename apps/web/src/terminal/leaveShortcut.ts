/** Alt+Shift+Q moves the keyboard out of a terminal or chat to the tab strip (DESIGN.md). */
export function isLeaveShortcut(event: KeyboardEvent): boolean {
	return (
		event.type === "keydown" &&
		event.altKey &&
		event.shiftKey &&
		event.key.toLowerCase() === "q"
	);
}
