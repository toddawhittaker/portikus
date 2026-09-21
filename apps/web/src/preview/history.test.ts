/**
 * The Back and Forward guard (BROWSER-HANDLING.md §12, issue #271): a step
 * that moves the Portikus page instead of the frame is undone.
 */
import { expect, test } from "vitest";
import { type HistoryWindow, stepJointHistory } from "./history.js";

/**
 * A stand-in for the browser tab. `movesPortikus` says whether a step takes
 * the Portikus page itself, which is the case the guard has to catch.
 */
function fakeWindow(movesPortikus: boolean) {
	const calls: string[] = [];
	const listeners = new Set<() => void>();
	const win: HistoryWindow = {
		location: { href: "https://portikus.example.edu/workspaces/1" },
		history: {
			back: () => {
				calls.push("back");
				move();
			},
			forward: () => {
				calls.push("forward");
				move();
			},
		},
		addEventListener: (_type, listener) => listeners.add(listener),
		removeEventListener: (_type, listener) => listeners.delete(listener),
		setTimeout: (callback) => {
			timers.push(callback);
			return 0;
		},
	};
	const timers: (() => void)[] = [];
	let stepped = 0;

	function move() {
		stepped += 1;
		if (!movesPortikus) return;
		// Only the first step moves the Portikus page; the undo puts it back.
		win.location.href =
			stepped % 2 === 1
				? "https://portikus.example.edu/projects"
				: "https://portikus.example.edu/workspaces/1";
		for (const listener of [...listeners]) listener();
	}

	return { win, calls, timers };
}

test("a step that only moves the frame is left alone", async () => {
	const { win, calls, timers } = fakeWindow(false);
	const stepping = stepJointHistory("back", win);
	// Nothing moved the Portikus page, so the timer is what settles it.
	for (const fire of timers) fire();
	await stepping;
	expect(calls).toEqual(["back"]);
});

test("a step that moves the Portikus page is undone", async () => {
	const { win, calls } = fakeWindow(true);
	await stepJointHistory("back", win);
	expect(calls).toEqual(["back", "forward"]);
	expect(win.location.href).toBe("https://portikus.example.edu/workspaces/1");
});

test("a forward step that moves the Portikus page is undone with back", async () => {
	const { win, calls } = fakeWindow(true);
	await stepJointHistory("forward", win);
	expect(calls).toEqual(["forward", "back"]);
});

test("the guard settles once, even if popstate and the timer both arrive", async () => {
	const { win, calls, timers } = fakeWindow(true);
	await stepJointHistory("back", win);
	for (const fire of timers) fire();
	expect(calls).toEqual(["back", "forward"]);
});
