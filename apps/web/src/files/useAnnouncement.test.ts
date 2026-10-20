import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ANNOUNCE_GAP_MS, useAnnouncement } from "./useAnnouncement.js";

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

/** SPEC.md §25.8: a screen reader hears the same words a second time. */
test("the same words twice empty the region in between, so both are spoken", () => {
	const { result } = renderHook(() => useAnnouncement());
	act(() => result.current[1]("Opened a.txt as a tab."));
	expect(result.current[0]).toBe("");
	act(() => vi.advanceTimersByTime(ANNOUNCE_GAP_MS));
	expect(result.current[0]).toBe("Opened a.txt as a tab.");

	act(() => result.current[1]("Opened a.txt as a tab."));
	expect(result.current[0]).toBe("");
	act(() => vi.advanceTimersByTime(ANNOUNCE_GAP_MS));
	expect(result.current[0]).toBe("Opened a.txt as a tab.");
});

test("a second call before the first lands says only the newer words", () => {
	const { result } = renderHook(() => useAnnouncement());
	act(() => {
		result.current[1]("first");
		result.current[1]("second");
	});
	act(() => vi.advanceTimersByTime(ANNOUNCE_GAP_MS));
	expect(result.current[0]).toBe("second");
});
