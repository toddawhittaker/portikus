/**
 * The guard that keeps the code side and the rich side of a Markdown tab from
 * echoing each other for ever (SPEC.md §13.4, issue #155).
 */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { debounce, hasChanged } from "./markdownSync.js";

test("text either side has not seen is a change worth acting on", () => {
	expect(hasChanged("# One\n", "# Two\n")).toBe(true);
});

test("the same text coming back is not a change", () => {
	expect(hasChanged("# One\n", "# One\n")).toBe(false);
});

test("the guard ends the loop after one round trip", () => {
	// The rich side types, the tab stores it, the tab hands it back.
	let lastSeen = "a";
	const typed = "ab";
	expect(hasChanged(lastSeen, typed)).toBe(true);
	lastSeen = typed;
	expect(hasChanged(lastSeen, typed)).toBe(false);
});

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

test("only the last value of a burst of typing is sent", () => {
	const seen: string[] = [];
	const pending = debounce<string>((value) => seen.push(value), 300);
	pending.call("a");
	pending.call("ab");
	pending.call("abc");
	vi.advanceTimersByTime(299);
	expect(seen).toEqual([]);
	vi.advanceTimersByTime(1);
	expect(seen).toEqual(["abc"]);
});

test("a flush sends what is waiting at once, and only once", () => {
	const seen: string[] = [];
	const pending = debounce<string>((value) => seen.push(value), 300);
	pending.call("a");
	pending.flush();
	expect(seen).toEqual(["a"]);
	vi.advanceTimersByTime(1000);
	expect(seen).toEqual(["a"]);
});

test("a flush with nothing waiting does nothing", () => {
	const seen: string[] = [];
	const pending = debounce<string>((value) => seen.push(value), 300);
	pending.flush();
	expect(seen).toEqual([]);
});

test("a cancelled call never arrives", () => {
	const seen: string[] = [];
	const pending = debounce<string>((value) => seen.push(value), 300);
	pending.call("a");
	pending.cancel();
	vi.advanceTimersByTime(1000);
	pending.flush();
	expect(seen).toEqual([]);
});
