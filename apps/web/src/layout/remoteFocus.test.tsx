import { act, cleanup, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { REMOTE_FOCUS_LOST, useRemoteFocusFallback } from "./remoteFocus.js";
import { createLayoutStore, type LayoutStore } from "./store.js";

afterEach(() => {
	cleanup();
	vi.useRealTimers();
});

function Probe({ store }: { store: LayoutStore }) {
	const area = useRef<HTMLDivElement | null>(null);
	const said = useRemoteFocusFallback(store, area);
	return (
		<main tabIndex={-1}>
			<div ref={area} />
			<p data-testid="said">{said}</p>
		</main>
	);
}

test("a second focus loss in a row empties the region, then says it again", () => {
	vi.useFakeTimers();
	const store = createLayoutStore();
	const view = render(<Probe store={store} />);
	const said = () => view.getByTestId("said").textContent;
	const lose = () =>
		act(() => {
			(document.activeElement as HTMLElement | null)?.blur();
			store.setState({ remoteFocusLost: store.getState().remoteFocusLost + 1 });
		});

	lose();
	act(() => {
		vi.advanceTimersByTime(200);
	});
	expect(said()).toBe(REMOTE_FOCUS_LOST);

	lose();
	expect(said()).toBe("");
	act(() => {
		vi.advanceTimersByTime(200);
	});
	expect(said()).toBe(REMOTE_FOCUS_LOST);
});
