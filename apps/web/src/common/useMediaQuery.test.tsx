import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { useMediaQuery } from "./useMediaQuery.js";

afterEach(() => vi.unstubAllGlobals());

test("it reads the query now and follows its changes", () => {
	let matches = false;
	const listeners = new Set<() => void>();
	vi.stubGlobal("matchMedia", (query: string) => ({
		media: query,
		get matches() {
			return matches;
		},
		addEventListener: (_: string, listener: () => void) => listeners.add(listener),
		removeEventListener: (_: string, listener: () => void) =>
			listeners.delete(listener),
	}));
	const { result, unmount } = renderHook(() => useMediaQuery("(width < 56rem)"));
	expect(result.current).toBe(false);
	matches = true;
	act(() => {
		for (const listener of listeners) listener();
	});
	expect(result.current).toBe(true);
	unmount();
	expect(listeners.size).toBe(0);
});

test("without matchMedia it is false", () => {
	vi.stubGlobal("matchMedia", undefined);
	const { result } = renderHook(() => useMediaQuery("(width < 56rem)"));
	expect(result.current).toBe(false);
});
