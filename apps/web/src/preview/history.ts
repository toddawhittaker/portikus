/**
 * Back and Forward for the Preview tab (BROWSER-HANDLING.md §12, issue
 * #271).
 *
 * The frame is cross-origin, so its own history cannot be read. It does not
 * need to be: every navigation inside the frame, including a single-page
 * application's `pushState`, is an entry in the browser tab's joint history,
 * so stepping the Portikus page's history steps the frame.
 *
 * The risk is stepping past the frame's entries and moving the Portikus page
 * itself. There is no way to ask a browser how many entries belong to the
 * frame, so this steps first and checks afterwards: if the Portikus page's
 * own URL changed, the step is undone with the opposite call and the frame
 * is left where it was.
 */

/** How long a step is given to settle before its effect is checked. */
export const HISTORY_SETTLE_MS = 300;

/** The little of `window` this needs, so a test can stand in for it. */
export interface HistoryWindow {
	location: { href: string };
	history: { back: () => void; forward: () => void };
	addEventListener: (type: "popstate", listener: () => void) => void;
	removeEventListener: (type: "popstate", listener: () => void) => void;
	setTimeout: (callback: () => void, ms: number) => unknown;
}

/**
 * Step the joint session history one entry, undoing the step if it moved
 * the Portikus page rather than the frame.
 */
export function stepJointHistory(
	direction: "back" | "forward",
	win: HistoryWindow,
): Promise<void> {
	const before = win.location.href;
	const step = direction === "back" ? win.history.back : win.history.forward;
	const undo = direction === "back" ? win.history.forward : win.history.back;

	return new Promise((resolve) => {
		let settled = false;
		const finish = () => {
			if (settled) return;
			settled = true;
			win.removeEventListener("popstate", onPopState);
			// A changed Portikus URL means the step left the frame's entries.
			if (win.location.href !== before) undo.call(win.history);
			resolve();
		};
		// A traversal that moves the Portikus page fires popstate here; one
		// that moves only the frame does not, so the timer is the other end.
		function onPopState() {
			finish();
		}
		win.addEventListener("popstate", onPopState);
		win.setTimeout(finish, HISTORY_SETTLE_MS);
		step.call(win.history);
	});
}
