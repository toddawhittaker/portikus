/**
 * Back and Forward for the Preview tab (BROWSER-HANDLING.md §12, issues
 * #271 and #283).
 *
 * The frame is cross-origin, so its own history cannot be read. It does not
 * need to be: every navigation inside the frame, including a single-page
 * application's `pushState`, is an entry in the browser tab's joint history,
 * so stepping the Portikus page's history steps the frame.
 *
 * The danger is stepping past the frame's entries, because the entries before
 * them belong to the Portikus page itself and one of them is the document the
 * student came from. Taking that one unloads the whole workspace.
 *
 * An anchor entry and a count of steps do the work together. When the first
 * Preview tab appears we call `history.pushState(state, "", location.href)`
 * with our marker mixed into whatever state the router had put there. That
 * adds one entry of our own at the current URL, which changes nothing on
 * screen, and it puts us at the very end of the history list. From there:
 *
 *  - Every entry the frame creates lands after the anchor, so
 *    `history.length - anchorLength` is how many entries the frame has added.
 *  - `history.length` does not shrink when we step back, so the count of
 *    entries is not on its own a test of where we are. `stepsBack` is: it
 *    counts the steps we have taken and not undone, so Back is allowed only
 *    while `history.length - anchorLength > stepsBack`. Without the count, a
 *    second Back after one frame navigation walked off the anchor, and on a
 *    workspace page reached by a real page load the next entry back is
 *    another document.
 *  - `history.state` cannot be the test: Chromium leaves the top document's
 *    state untouched when a subframe navigates, so it still reads as the
 *    anchor after the frame has moved on.
 *  - A step that does land before the anchor anyway, which a press of the
 *    browser's own Back button can still cause, gives a `popstate` whose
 *    state is not ours. We push the anchor again straight away, which both
 *    restores the guard and truncates the entries ahead.
 *  - When the Portikus route changes underneath us, a project switch say,
 *    the router's own entries would otherwise look like frame entries. The
 *    anchor is at a path, and a path that no longer matches re-anchors.
 *
 * Forward needs no guard: there is never anything ahead of the frame's own
 * entries that belongs to another page.
 *
 * One guard serves every Preview tab, because there is one history list per
 * browser tab, and it lives as long as the document: closing the last Preview
 * tab drops the `popstate` listener but keeps the anchor, so opening and
 * closing tabs does not add an entry each time.
 */

/** The state we put on our own history entry, mixed into the router's. */
interface Sentinel {
	pkPreviewSentinel: string;
}

/** Whether a history entry's state is an anchor we pushed. */
export function isSentinel(state: unknown): state is Sentinel {
	return (
		typeof state === "object" &&
		state !== null &&
		typeof (state as Sentinel).pkPreviewSentinel === "string"
	);
}

/** The little of `window` this needs, so a test can stand in for it. */
export interface HistoryWindow {
	location: { href: string; pathname: string };
	history: {
		length: number;
		/** What the router put on the current entry; we push it back with ours. */
		state: unknown;
		back: () => void;
		forward: () => void;
		pushState: (state: unknown, unused: string, url: string) => void;
	};
	addEventListener: (
		type: "popstate",
		listener: (event: { state: unknown }) => void,
	) => void;
	removeEventListener: (
		type: "popstate",
		listener: (event: { state: unknown }) => void,
	) => void;
}

/** What a Preview tab holds while it is open. */
export interface PreviewHistory {
	/** Whether the frame has an entry to go back to. */
	canGoBack: () => boolean;
	/** Step back, or do nothing and answer false when there is nowhere to go. */
	back: () => boolean;
	forward: () => void;
	/** Let go; the listener goes when the last tab lets go, the anchor stays. */
	release: () => void;
}

interface Guard {
	win: HistoryWindow;
	/** Labels the anchor entry; any anchor counts as ours whatever the label. */
	tabId: string;
	/** `history.length` just after the anchor was pushed. */
	anchorLength: number;
	/** The Portikus path the anchor was pushed at. */
	anchorPath: string;
	/** Steps back taken since the anchor and not yet undone. */
	stepsBack: number;
	onPopState: (event: { state: unknown }) => void;
	/** How many Preview tabs are open; the listener is on while this is above 0. */
	holders: number;
	listening: boolean;
}

/** The one guard for this document. */
let guard: Guard | null = null;

/**
 * Take the guard for one Preview tab, pushing the anchor entry if there is
 * not one already. `tabId` only labels the entry; any anchor counts as ours.
 */
export function attachPreviewHistory(
	tabId: string,
	win: HistoryWindow,
): PreviewHistory {
	if (guard && guard.win !== win) {
		// A different window means the old guard's listener is gone with it.
		guard = null;
	}
	if (!guard) {
		const fresh: Guard = {
			win,
			tabId,
			anchorLength: 0,
			anchorPath: win.location.pathname,
			stepsBack: 0,
			onPopState: (event: { state: unknown }) => {
				// Our own entries need nothing: the step that reached one was
				// counted when we took it. Anything else means the step left
				// the frame's entries, so the anchor goes back down here.
				if (isSentinel(event.state)) return;
				anchor();
			},
			holders: 0,
			listening: false,
		};
		guard = fresh;
		anchor();
	}
	guard.tabId = tabId;
	guard.holders += 1;
	if (!guard.listening) {
		win.addEventListener("popstate", guard.onPopState);
		guard.listening = true;
	}
	syncAnchor();

	let released = false;
	return {
		canGoBack: () => {
			syncAnchor();
			return canGoBack();
		},
		back: () => {
			syncAnchor();
			if (!canGoBack() || !guard) return false;
			guard.stepsBack += 1;
			win.history.back();
			return true;
		},
		forward: () => {
			syncAnchor();
			if (guard && guard.stepsBack > 0) guard.stepsBack -= 1;
			win.history.forward();
		},
		release: () => {
			if (released || !guard) return;
			released = true;
			guard.holders -= 1;
			if (guard.holders > 0) return;
			// The anchor and its counts stay; only the listener goes, so an
			// open and close cycle does not add a history entry each time.
			guard.win.removeEventListener("popstate", guard.onPopState);
			guard.listening = false;
		},
	};
}

/** Put the anchor at the current URL and remember where the list ended. */
function anchor(): void {
	if (!guard) return;
	const { win } = guard;
	const previous = typeof win.history.state === "object" ? win.history.state : null;
	win.history.pushState(
		{ ...previous, pkPreviewSentinel: guard.tabId },
		"",
		win.location.href,
	);
	guard.anchorLength = win.history.length;
	guard.anchorPath = win.location.pathname;
	guard.stepsBack = 0;
}

/**
 * Re-anchor when the anchor no longer describes where we are: the Portikus
 * route has changed, or entries have gone from the list.
 */
function syncAnchor(): void {
	if (!guard) return;
	if (
		guard.win.location.pathname !== guard.anchorPath ||
		guard.win.history.length < guard.anchorLength
	) {
		anchor();
	}
}

function canGoBack(): boolean {
	if (!guard) return false;
	return guard.win.history.length - guard.anchorLength > guard.stepsBack;
}

/** Drop the guard outright. Only a test needs this. */
export function resetPreviewHistory(): void {
	if (guard?.listening) guard.win.removeEventListener("popstate", guard.onPopState);
	guard = null;
}
