/**
 * The guard that keeps the code side and the rich side of a Markdown tab from
 * echoing each other for ever (SPEC.md §13.4, issue #155).
 */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { debounce, isIncomingNew, isOutgoingNew } from "./markdownSync.js";

test("text the other side changed is loaded", () => {
	expect(isIncomingNew("# One\n", "# Two\n")).toBe(true);
});

test("this side's own text coming back is ignored", () => {
	expect(isIncomingNew("# One\n", "# One\n")).toBe(false);
});

test("a real edit is sent on", () => {
	expect(isOutgoingNew("# One\n", "# One and a half\n")).toBe(true);
});

test("an editor reporting the text it was given is not an edit", () => {
	expect(isOutgoingNew("# One\n", "# One\n")).toBe(false);
});

test("the guard ends the loop after one round trip", () => {
	// The rich side types, the tab stores it, the tab hands it back.
	let lastSeen = "a";
	const typed = "ab";
	expect(isOutgoingNew(lastSeen, typed)).toBe(true);
	lastSeen = typed;
	expect(isIncomingNew(lastSeen, typed)).toBe(false);
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
