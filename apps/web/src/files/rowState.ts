/**
 * The file tree's per-row state: the focused row, the selection and the
 * drag in progress. It is kept outside React context so a change re-renders
 * only the rows whose state changed, not every row of a directory thousands
 * of entries long (SPEC.md §11.2).
 */
import { createStore, type StoreApi, useStore } from "zustand";
import { EMPTY_SELECTION, type Selection } from "./selection.js";

interface RowState {
	focusedPath: string | null;
	selection: Selection;
	/** The row being dragged to another folder. */
	draggedPath: string | null;
	/** The folder a drag would land in now; the empty path is the project root. */
	dropDir: string | null;
	setFocusedPath: (path: string | null) => void;
	setSelection: (update: Selection | ((current: Selection) => Selection)) => void;
}

export type RowStateStore = StoreApi<RowState>;

export function createRowStateStore(): RowStateStore {
	return createStore<RowState>((set) => ({
		focusedPath: null,
		selection: EMPTY_SELECTION,
		draggedPath: null,
		dropDir: null,
		setFocusedPath: (focusedPath) => set({ focusedPath }),
		setSelection: (update) =>
			set((state) => ({
				selection: typeof update === "function" ? update(state.selection) : update,
			})),
	}));
}

/** One row's view of the store; each value is a boolean so unrelated changes skip the row. */
export function useRowState(store: RowStateStore, path: string) {
	const focused = useStore(store, (state) => state.focusedPath === path);
	const selected = useStore(store, (state) => state.selection.paths.includes(path));
	// One selector, so the selection filling or emptying redraws only the focused row.
	const current = useStore(
		store,
		(state) => state.focusedPath === path && state.selection.paths.length === 0,
	);
	const dragging = useStore(store, (state) => state.draggedPath === path);
	const dropTarget = useStore(store, (state) => state.dropDir === path);
	return { focused, selected, current, dragging, dropTarget };
}
