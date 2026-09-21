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

const PORTIKUS = "https://portikus.example.edu/workspaces/1";

/**
 * A stand-in for one browser tab's joint history. Entries hold the state the
 * top document sees; an entry a subframe made copies the state of the entry
 * before it, which is what Chromium does.
 */
function fakeWindow() {
	const entries: { href: string; state: unknown }[] = [{ href: PORTIKUS, state: null }];
	let at = 0;
	const listeners = new Set<(event: { state: unknown }) => void>();

	function fire() {
		for (const listener of [...listeners]) listener({ state: entries[at]?.state });
	}

	const win: HistoryWindow = {
		location: { href: PORTIKUS },
		history: {
			get length() {
				return entries.length;
			},
			back: () => {
				if (at === 0) throw new Error("the Portikus document was unloaded");
				at -= 1;
				win.location.href = entries[at]?.href ?? "";
				fire();
			},
			forward: () => {
				if (at >= entries.length - 1) return;
				at += 1;
				win.location.href = entries[at]?.href ?? "";
				fire();
			},
			pushState: (state, _unused, url) => {
				entries.length = at + 1;
				entries.push({ href: url, state });
				at += 1;
				win.location.href = url;
			},
		},
		addEventListener: (_type, listener) => listeners.add(listener),
		removeEventListener: (_type, listener) => listeners.delete(listener),
	};

	/** What the frame does: a new joint entry that keeps the top state. */
	function frameNavigates() {
		entries.length = at + 1;
		entries.push({ href: win.location.href, state: entries[at]?.state ?? null });
		at += 1;
	}

	return { win, frameNavigates, position: () => at, entries };
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

test("stepping off the anchor re-anchors and Back then refuses", () => {
	const tab = fakeWindow();
	const history = attachPreviewHistory("tab-1", tab.win);
	tab.frameNavigates();
	expect(history.back()).toBe(true);
	// One step too many: this lands on the Portikus document's own entry and
	// the popstate listener puts the anchor back.
	expect(history.back()).toBe(true);
	expect(tab.win.location.href).toBe(PORTIKUS);
	expect(history.canGoBack()).toBe(false);
	expect(history.back()).toBe(false);
});

test("Back can never reach the entry before the Portikus page", () => {
	const tab = fakeWindow();
	const history = attachPreviewHistory("tab-1", tab.win);
	tab.frameNavigates();
	// The fake throws if a step would unload the document.
	for (let press = 0; press < 20; press += 1) history.back();
	expect(tab.win.location.href).toBe(PORTIKUS);
});

test("Forward is passed straight through", () => {
	const tab = fakeWindow();
	const history = attachPreviewHistory("tab-1", tab.win);
	tab.frameNavigates();
	history.back();
	const before = tab.position();
	history.forward();
	expect(tab.position()).toBe(before + 1);
});

test("a second Preview tab shares the one anchor", () => {
	const tab = fakeWindow();
	const first = attachPreviewHistory("tab-1", tab.win);
	const second = attachPreviewHistory("tab-2", tab.win);
	// One anchor, not two: there is one history list per browser tab.
	expect(tab.entries).toHaveLength(2);
	first.release();
	// The guard is still held, so the second tab still works.
	tab.frameNavigates();
	expect(second.canGoBack()).toBe(true);
	second.release();
});
