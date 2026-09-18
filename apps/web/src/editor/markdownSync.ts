/**
 * Keeping the code side and the rich side of a Markdown tab in step
 * (SPEC.md §13.4, issue #155).
 *
 * Both sides edit one buffer: the file's Markdown text, which the tab holds.
 * Each side reports its own edits and is told about the other's. Without a
 * guard that is a loop: the rich editor emits text, the tab stores it, the
 * tab hands it back to the rich editor, the rich editor emits it again. The
 * guard is the plainest one that works: remember the last text this side
 * produced or was given, and ignore anything equal to it.
 */

/**
 * True when text arriving from the tab is genuinely new for this side, so it
 * should be loaded. False when it is this side's own edit coming back.
 */
export function isIncomingNew(lastSeen: string, incoming: string): boolean {
	return incoming !== lastSeen;
}

/**
 * True when text this side produced differs from what it last saw, so it is a
 * real edit worth sending on. False when the editor re-reported the same text,
 * which happens when it reformats or when a selection changes nothing.
 */
export function isOutgoingNew(lastSeen: string, outgoing: string): boolean {
	return outgoing !== lastSeen;
}

/**
 * The rich editor writes its Markdown without a final line break. Text files
 * end with one, and without this every rich edit would quietly strip it and
 * show up as a change in `git diff`.
 */
export function endWithNewline(text: string): string {
	if (text === "" || text.endsWith("\n")) return text;
	return `${text}\n`;
}

/** A pending call that can be replaced or dropped. */
export interface Debounced<T> {
	/** Run `fn` with this value once `delayMs` has passed with no newer call. */
	call: (value: T) => void;
	/** Run any pending call now. */
	flush: () => void;
	/** Drop any pending call. */
	cancel: () => void;
}

/**
 * Wait for a pause in typing before acting. The rich editor reports a change
 * on every keystroke; re-rendering Monaco that often makes typing feel heavy.
 */
export function debounce<T>(fn: (value: T) => void, delayMs: number): Debounced<T> {
	let timer: ReturnType<typeof setTimeout> | null = null;
	let pending: { value: T } | null = null;
	function cancel() {
		if (timer !== null) clearTimeout(timer);
		timer = null;
		pending = null;
	}
	function flush() {
		if (pending === null) return;
		const { value } = pending;
		cancel();
		fn(value);
	}
	return {
		call(value: T) {
			pending = { value };
			if (timer !== null) clearTimeout(timer);
			timer = setTimeout(flush, delayMs);
		},
		flush,
		cancel,
	};
}
