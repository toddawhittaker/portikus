/**
 * Back and Forward for the Preview tab (BROWSER-HANDLING.md §12, issues
 * #271 and #283).
 *
 * The frame is cross-origin, so its own history cannot be read. It does not
 * need to be: every navigation inside the frame, including a single-page
 * application's `pushState`, is an entry in the browser tab's joint history,
 * so stepping the Portikus page's history steps the frame.
 *
 * The danger is stepping past the frame's entries, because the next one back
 * belongs to the Portikus document itself and taking it unloads the whole
 * workspace. The earlier version stepped first and undid the step 300 ms
 * later if the URL had moved; by then the document was already gone and the
 * undo never ran. So this version never lets the step reach that far.
 *
 * An anchor entry does the work. When the first Preview tab appears we call
 * `history.pushState({ pkPreviewSentinel: tabId }, "", location.href)`. That
 * adds one entry of our own at the current URL, which changes nothing on
 * screen, and it puts us at the very end of the history list. From there:
 *
 *  - Every entry the frame creates lands after the anchor and makes
 *    `history.length` bigger than the length we recorded when we anchored.
 *    So `history.length > anchorLength` means "the frame has somewhere to go
 *    back to", and it is the whole test Back needs. `history.state` cannot be
 *    that test: Chromium leaves the top document's state untouched when a
 *    subframe navigates, so it still reads as the anchor after the frame has
 *    moved on.
 *  - Stepping back off the anchor is a same-document traversal, because the
 *    anchor and the page before it are the same Portikus document at the same
 *    URL. Nothing unloads, and we get a `popstate` whose state is not ours.
 *    We push the anchor again straight away, which both restores the guard
 *    and truncates the entries ahead, so `history.length` is back down to the
 *    anchor length and Back refuses from then on.
 *
 * Forward needs no guard: there is never anything ahead of the frame's own
 * entries that belongs to another page.
 *
 * One guard serves every Preview tab, because there is one history list per
 * browser tab. The last tab to let go removes the listener.
 */

/** The state we put on our own history entry. */
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
	location: { href: string };
	history: {
		length: number;
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
	/** Let go of the guard; the listener goes when the last tab lets go. */
	release: () => void;
}

/** The one guard, and how many Preview tabs are holding it. */
let guard: {
	win: HistoryWindow;
	anchorLength: number;
	onPopState: (event: { state: unknown }) => void;
	holders: number;
} | null = null;

/**
 * Take the guard for one Preview tab, pushing the anchor entry if this is the
 * first tab. `tabId` only labels the entry; any anchor counts as ours.
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
		const fresh = {
			win,
			anchorLength: 0,
			onPopState: (event: { state: unknown }) => {
				// Our own entries need nothing. Anything else means the step
				// left the frame's entries, so the anchor goes back down.
				if (isSentinel(event.state)) return;
				anchor(tabId);
			},
			holders: 0,
		};
		guard = fresh;
		win.addEventListener("popstate", fresh.onPopState);
		anchor(tabId);
	}
	guard.holders += 1;

	let released = false;
	return {
		canGoBack: () => canGoBack(),
		back: () => {
			if (!canGoBack()) return false;
			win.history.back();
			return true;
		},
		forward: () => win.history.forward(),
		release: () => {
			if (released || !guard) return;
			released = true;
			guard.holders -= 1;
			if (guard.holders > 0) return;
			win.removeEventListener("popstate", guard.onPopState);
			guard = null;
		},
	};
}

/** Put the anchor at the current URL and remember where the list ended. */
function anchor(tabId: string): void {
	if (!guard) return;
	const { win } = guard;
	const state: Sentinel = { pkPreviewSentinel: tabId };
	win.history.pushState(state, "", win.location.href);
	guard.anchorLength = win.history.length;
}

function canGoBack(): boolean {
	return guard !== null && guard.win.history.length > guard.anchorLength;
}

/** Drop the guard outright. Only a test needs this. */
export function resetPreviewHistory(): void {
	if (guard) guard.win.removeEventListener("popstate", guard.onPopState);
	guard = null;
}
