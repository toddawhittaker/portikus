/**
 * The Back guard (BROWSER-HANDLING.md §12, issues #271 and #283): Back may
 * step the frame, and may never step the Portikus document away.
 */
import { afterEach, expect, test } from "vitest";
import {
	attachPreviewHistory,
	type HistoryWindow,
	isSentinel,
	resetPreviewHistory,
} from "./history.js";

afterEach(() => resetPreviewHistory());

const ORIGIN = "https://portikus.example.edu";
const PORTIKUS = `${ORIGIN}/workspaces/1`;

/**
 * A stand-in for one browser tab's joint history. Entries hold the state the
 * top document sees; an entry a subframe made copies the state of the entry
 * before it, which is what Chromium does. Entry 0 is the Portikus document
 * itself, and the fake throws if a step would go past it, because in the
 * browser that step loads another document and the workspace is gone.
 */
function fakeWindow() {
	const entries: { href: string; state: unknown }[] = [{ href: PORTIKUS, state: null }];
	let at = 0;
	const listeners = new Set<(event: { state: unknown }) => void>();

	function fire() {
		for (const listener of [...listeners]) listener({ state: entries[at]?.state });
	}

	const win: HistoryWindow = {
		location: { href: PORTIKUS, pathname: new URL(PORTIKUS).pathname },
		history: {
			get length() {
				return entries.length;
			},
			get state() {
				return entries[at]?.state ?? null;
			},
			back: () => {
				if (at === 0) throw new Error("the Portikus document was unloaded");
				at -= 1;
				setHref(entries[at]?.href ?? "");
				fire();
			},
			forward: () => {
				if (at >= entries.length - 1) return;
				at += 1;
				setHref(entries[at]?.href ?? "");
				fire();
			},
			pushState: (state, _unused, url) => {
				entries.length = at + 1;
				entries.push({ href: url, state });
				at += 1;
				setHref(url);
			},
		},
		addEventListener: (_type, listener) => listeners.add(listener),
		removeEventListener: (_type, listener) => listeners.delete(listener),
	};

	function setHref(url: string): void {
		win.location.href = url;
		win.location.pathname = url === "" ? "" : new URL(url).pathname;
	}

	/** What the frame does: a new joint entry that keeps the top state. */
	function frameNavigates() {
		entries.length = at + 1;
		entries.push({ href: win.location.href, state: entries[at]?.state ?? null });
		at += 1;
	}

	/** What the Portikus router does when the student opens another project. */
	function routeChanges(path: string, state: unknown) {
		win.history.pushState(state, "", `${ORIGIN}${path}`);
	}

	return { win, frameNavigates, routeChanges, position: () => at, entries };
}

test("a sentinel is recognised and nothing else is", () => {
	expect(isSentinel({ pkPreviewSentinel: "tab-1" })).toBe(true);
	expect(isSentinel(null)).toBe(false);
	expect(isSentinel({ router: "/projects" })).toBe(false);
	expect(isSentinel({ pkPreviewSentinel: 7 })).toBe(false);
});

test("mounting pushes one anchor entry at the same URL", () => {
	const tab = fakeWindow();
	attachPreviewHistory("tab-1", tab.win);
	expect(tab.entries).toHaveLength(2);
	expect(tab.entries[1]?.state).toEqual({ pkPreviewSentinel: "tab-1" });
	expect(tab.win.location.href).toBe(PORTIKUS);
});

test("the anchor keeps the state the router put on the entry", () => {
	const tab = fakeWindow();
	// TanStack Router keeps its index and key in history.state; an anchor
	// that threw them away would break its navigation.
	tab.routeChanges("/workspaces/1/projects/a", { index: 3, key: "abc" });
	attachPreviewHistory("tab-1", tab.win);
	expect(tab.win.history.state).toEqual({
		index: 3,
		key: "abc",
		pkPreviewSentinel: "tab-1",
	});
});

test("Back on a fresh preview refuses instead of stepping", () => {
	const tab = fakeWindow();
	const history = attachPreviewHistory("tab-1", tab.win);
	expect(history.canGoBack()).toBe(false);
	expect(history.back()).toBe(false);
	// Nothing moved: still on the anchor, with the Portikus URL intact.
	expect(tab.position()).toBe(1);
	expect(tab.win.location.href).toBe(PORTIKUS);
});

test("Back steps once the frame has made an entry", () => {
	const tab = fakeWindow();
	const history = attachPreviewHistory("tab-1", tab.win);
	tab.frameNavigates();
	expect(history.canGoBack()).toBe(true);
	expect(history.back()).toBe(true);
	expect(tab.position()).toBe(1);
	expect(tab.win.location.href).toBe(PORTIKUS);
});

test("the state still reads as the anchor after the frame moves", () => {
	const tab = fakeWindow();
	attachPreviewHistory("tab-1", tab.win);
	tab.frameNavigates();
	// The guard must not test history.state: Chromium leaves it alone here.
	expect(isSentinel(tab.entries[tab.position()]?.state)).toBe(true);
});

test("a second Back after one frame entry refuses", () => {
	const tab = fakeWindow();
	const history = attachPreviewHistory("tab-1", tab.win);
	tab.frameNavigates();
	expect(history.back()).toBe(true);
	// The list did not get shorter when we stepped, so only the count of
	// steps taken says we are back on the anchor with nowhere left to go.
	expect(tab.position()).toBe(1);
	expect(history.canGoBack()).toBe(false);
	expect(history.back()).toBe(false);
	expect(tab.position()).toBe(1);
	expect(tab.win.location.href).toBe(PORTIKUS);
});

test("Back can never reach the entry before the Portikus page", () => {
	const tab = fakeWindow();
	const history = attachPreviewHistory("tab-1", tab.win);
	tab.frameNavigates();
	tab.frameNavigates();
	// The fake throws if a step would unload the document.
	for (let press = 0; press < 20; press += 1) history.back();
	expect(tab.win.location.href).toBe(PORTIKUS);
	expect(tab.position()).toBe(1);
});

test("Forward is passed through and gives Back somewhere to go again", () => {
	const tab = fakeWindow();
	const history = attachPreviewHistory("tab-1", tab.win);
	tab.frameNavigates();
	history.back();
	const before = tab.position();
	history.forward();
	expect(tab.position()).toBe(before + 1);
	expect(history.canGoBack()).toBe(true);
});

test("a Portikus route change re-anchors, so Back does not rewind it", () => {
	const tab = fakeWindow();
	const history = attachPreviewHistory("tab-1", tab.win);
	// The student switches project while the Preview tab is open. Those are
	// the router's entries, not the frame's, and Back must leave them alone.
	tab.routeChanges("/workspaces/1/projects/a", { index: 1, key: "a" });
	tab.routeChanges("/workspaces/1/projects/b", { index: 2, key: "b" });
	expect(history.canGoBack()).toBe(false);
	expect(history.back()).toBe(false);
	// The frame's first entry after the switch is what Back may take.
	tab.frameNavigates();
	expect(history.back()).toBe(true);
	expect(history.canGoBack()).toBe(false);
});

test("stepping off the anchor re-anchors and Back then refuses", () => {
	const tab = fakeWindow();
	const history = attachPreviewHistory("tab-1", tab.win);
	tab.frameNavigates();
	// The browser's own Back button, which the guard cannot refuse: two
	// presses land before the anchor and the popstate listener puts it back.
	tab.win.history.back();
	tab.win.history.back();
	expect(tab.win.location.href).toBe(PORTIKUS);
	expect(isSentinel(tab.win.history.state)).toBe(true);
	expect(history.canGoBack()).toBe(false);
	expect(history.back()).toBe(false);
});

test("a second Preview tab shares the one anchor", () => {
	const tab = fakeWindow();
	attachPreviewHistory("tab-1", tab.win);
	const second = attachPreviewHistory("tab-2", tab.win);
	// One anchor, not two: there is one history list per browser tab.
	expect(tab.entries).toHaveLength(2);
	tab.frameNavigates();
	expect(second.canGoBack()).toBe(true);
});

test("opening and closing Preview tabs does not pile up history entries", () => {
	const tab = fakeWindow();
	for (let cycle = 0; cycle < 5; cycle += 1) {
		attachPreviewHistory(`tab-${cycle}`, tab.win);
	}
	expect(tab.entries).toHaveLength(2);
});

/**
 * The guard keeps watching even with no Preview tab open. It used to drop
 * the listener when the last tab closed, and then a student who pressed the
 * browser's own Back a few times and reopened a preview found the anchor
 * still where it had been: Back believed there were frame entries below it
 * and the next press took the workspace away.
 */
test("Back presses made with no Preview tab open are still seen", () => {
	const tab = fakeWindow();
	attachPreviewHistory("tab-1", tab.win);
	tab.frameNavigates();

	// The student closes the Preview tab and walks back by hand.
	tab.win.history.back();
	tab.win.history.back();

	// Reopening finds the anchor put back where the student now stands.
	const reopened = attachPreviewHistory("tab-2", tab.win);
	expect(reopened.canGoBack()).toBe(false);
	expect(reopened.back()).toBe(false);
	expect(tab.win.location.href).toBe(PORTIKUS);
});
