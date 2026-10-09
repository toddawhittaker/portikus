import { act, render } from "@testing-library/react";
import { expect, it } from "vitest";
import { createRowStateStore, type RowStateStore, useRowState } from "./rowState.js";

const renders = new Map<string, number>();

function Probe({ store, path }: { store: RowStateStore; path: string }) {
	const state = useRowState(store, path);
	renders.set(path, (renders.get(path) ?? 0) + 1);
	return <span data-testid={path} data-focused={state.focused} />;
}

/** SPEC.md §11.2: moving the focus in a long folder redraws only the rows it touches. */
it("re-renders only the rows whose focus or selection changed", () => {
	renders.clear();
	const store = createRowStateStore();
	render(
		<>
			<Probe store={store} path="a" />
			<Probe store={store} path="b" />
			<Probe store={store} path="c" />
		</>,
	);
	act(() => store.getState().setFocusedPath("a"));
	act(() => store.getState().setFocusedPath("b"));
	expect(renders.get("c")).toBe(1);
	expect(renders.get("a")).toBe(3);
	expect(renders.get("b")).toBe(2);
});

/** SPEC.md §11.2: a drag crossing a long folder redraws only the rows it touches. */
it("re-renders only the rows a drag starts on or passes over", () => {
	renders.clear();
	const store = createRowStateStore();
	render(
		<>
			<Probe store={store} path="a" />
			<Probe store={store} path="b" />
			<Probe store={store} path="c" />
		</>,
	);
	act(() => store.setState({ draggedPath: "a" }));
	act(() => store.setState({ dropDir: "b" }));
	act(() => store.setState({ dropDir: "" }));
	expect(renders.get("c")).toBe(1);
	expect(renders.get("a")).toBe(2);
	expect(renders.get("b")).toBe(3);
});

/** SPEC.md §11.2: the first Ctrl-click in a long folder redraws only the rows it changes. */
it("re-renders only the rows a first Ctrl-click changes", () => {
	renders.clear();
	const store = createRowStateStore();
	render(
		<>
			<Probe store={store} path="a" />
			<Probe store={store} path="b" />
			<Probe store={store} path="c" />
		</>,
	);
	act(() => store.getState().setFocusedPath("a"));
	act(() => {
		store.getState().setSelection((current) => ({ ...current, paths: ["b"] }));
		store.getState().setFocusedPath("b");
	});
	expect(renders.get("c")).toBe(1);
	expect(renders.get("a")).toBe(3);
	expect(renders.get("b")).toBe(2);
});
