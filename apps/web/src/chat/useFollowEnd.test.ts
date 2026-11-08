import { act, renderHook } from "@testing-library/react";
import { expect, test } from "vitest";
import { useFollowEnd } from "./useFollowEnd.js";

/** A scroll box whose sizes the test sets, since jsdom does no layout. */
function scrollBox(height: number, client = 100) {
	const node = document.createElement("div");
	const size = { height };
	Object.defineProperty(node, "scrollHeight", { get: () => size.height });
	Object.defineProperty(node, "clientHeight", { get: () => client });
	return { node, size };
}

function follow(node: HTMLElement) {
	return renderHook(() => useFollowEnd({ current: node }, { current: null }, true));
}

test("a scroll event that lands after the content grew keeps the view at the end", () => {
	const { node, size } = scrollBox(500);
	const view = follow(node);
	node.scrollTop = 400;
	act(() => view.result.current.onScroll());
	// A row opened below: the content grows before the stale scroll event is handled.
	size.height = 700;
	act(() => view.result.current.onScroll());
	expect(view.result.current.away).toBe(false);
	expect(node.scrollTop).toBe(700);
});

test("scrolling up past the end leaves it and offers the way back", () => {
	const { node } = scrollBox(500);
	const view = follow(node);
	node.scrollTop = 400;
	act(() => view.result.current.onScroll());
	node.scrollTop = 200;
	act(() => view.result.current.onScroll());
	expect(view.result.current.away).toBe(true);
	act(() => view.result.current.toEnd());
	expect(view.result.current.away).toBe(false);
});
