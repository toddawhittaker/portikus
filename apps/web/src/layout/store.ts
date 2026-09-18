/**
 * The live copy of one project's layout (SPEC.md §7.5). One store per
 * project: switching project mounts a new one, so nothing carries over.
 * `dirty` marks a structural change the persistence hook still has to save;
 * the active tab, the editor view states and the focused pane are local to
 * this browser and are kept in localStorage instead (local.ts, issue #161).
 */
import type { ProjectLayout } from "@portikus/contracts";
import { createContext, useCallback, useContext, useRef, useState } from "react";
import { createStore, useStore } from "zustand";
import { DEFAULT_ZOOM } from "../editor/zoom.js";
import type { LocalLayout } from "./local.js";
import * as tree from "./tree.js";

export interface LayoutState {
	layout: ProjectLayout;
	activeTabId: string | null;
	focusedTerminalId: string | null;
	/**
	 * Where a file tab should jump to when its editor opens, by tab id. It is
	 * a one-off request from this browser, so it is never saved.
	 */
	pendingLine: Record<string, number>;
	/**
	 * Which file tabs have been asked to show their diff, by tab id, counted
	 * so that asking twice is two requests. Local to this browser, like the
	 * pending line, and never saved.
	 */
	pendingDiff: Record<string, number>;
	/**
	 * Which file tabs have been asked to show the editor again, counted the
	 * same way. Reopening a file from the tree or a terminal link must take a
	 * tab that is showing its diff back to the editor.
	 */
	pendingEdit: Record<string, number>;
	/**
	 * Monaco's view state (cursor, selections, scroll) for each open file, by
	 * project-relative path. It belongs to this browser, so it is kept beside
	 * the layout rather than in the saved document (issue #161).
	 */
	viewStates: Record<string, unknown>;
	/**
	 * The editor zoom of each open file, by project-relative path. Issue #162
	 * asks for zoom that lasts the session only, so this one lives here and is
	 * never written to this browser's storage.
	 */
	zooms: Record<string, number>;
	/**
	 * The tabs that have been active, newest first, so closing a tab can go
	 * back to the one before it the way a browser does (issue #223). It only
	 * matters while this workspace is open, so it is neither saved to the
	 * server nor written to this browser's storage.
	 */
	tabHistory: string[];
	dirty: boolean;
	/** Replace the whole layout with what the server had saved. */
	load: (layout: ProjectLayout) => void;
	addTab: (terminalId: string) => void;
	/**
	 * Open a file tab, or activate the one already open for this path. With
	 * `diff` the tab is asked to show its diff rather than the editor
	 * (issue #160). False when there is no room for another tab, so the
	 * caller can say so.
	 */
	openFile: (path: string, options?: { line?: number; diff?: boolean }) => boolean;
	/** Close one whole tab. Terminal tabs close by closing their terminals. */
	closeTab: (tabId: string) => void;
	/** Read and forget the line a file tab was asked to jump to. */
	consumePendingLine: (tabId: string) => number | undefined;
	/** Read and forget whether a file tab was asked to show its diff. */
	consumePendingDiff: (tabId: string) => boolean;
	/** Read and forget whether a file tab was asked to show the editor. */
	consumePendingEdit: (tabId: string) => boolean;
	splitLeaf: (
		terminalId: string,
		direction: tree.SplitDirection,
		newTerminalId: string,
	) => void;
	removeLeaf: (terminalId: string) => void;
	replaceLeaf: (terminalId: string, newTerminalId: string) => void;
	moveTab: (from: number, to: number) => void;
	/** Drag one pane onto another (SPEC.md §9.3). */
	moveLeaf: (
		tabId: string,
		terminalId: string,
		targetTerminalId: string,
		edge: tree.DropEdge,
	) => void;
	/** Drag one pane out to the tab strip, where it becomes its own tab. */
	moveLeafToNewTab: (terminalId: string, index: number) => void;
	resize: (tabId: string, path: number[], sizes: number[]) => void;
	setActive: (tabId: string) => void;
	/** Remember where the cursor and scroll are in one open file. */
	setViewState: (path: string, viewState: unknown) => void;
	/** Remember the editor zoom of one open file for this session. */
	setZoom: (path: string, percent: number) => void;
	/** Put back what this browser remembered for this project (issue #161). */
	restoreLocal: (local: LocalLayout) => void;
	setFocused: (terminalId: string | null) => void;
	reconcile: (terminalIds: string[], endedIds?: string[]) => void;
	clearDirty: () => void;
}

export type LayoutStore = ReturnType<typeof createLayoutStore>;

/**
 * A terminal id belongs to exactly one pane. A create refetches the terminal
 * list, so a reconcile can put the new terminal in a tab of its own before
 * the action that asked for it gets to place it; dropping any pane it already
 * has first keeps that from leaving two copies behind.
 */
function place(layout: ProjectLayout, terminalId: string): ProjectLayout {
	return tree.layoutTerminalIds(layout).includes(terminalId)
		? tree.removeLeaf(layout, terminalId)
		: layout;
}

/** Put `tabId` at the front of the history, with no duplicates. */
function remember(history: string[], tabId: string | null): string[] {
	if (tabId === null) return history;
	return [tabId, ...history.filter((id) => id !== tabId)];
}

/** Drop tabs that are no longer in the layout. */
function pruneHistory(history: string[], layout: ProjectLayout): string[] {
	const ids = new Set(layout.tabs.map((tab) => tab.id));
	return history.filter((id) => ids.has(id));
}

/**
 * Keep the active tab pointing at a tab that still exists, preferring the one
 * that was active most recently (issue #223).
 */
function pickActive(
	layout: ProjectLayout,
	current: string | null,
	history: string[],
): string | null {
	if (current && layout.tabs.some((tab) => tab.id === current)) return current;
	return history[0] ?? layout.tabs[0]?.id ?? null;
}

export function createLayoutStore() {
	return createStore<LayoutState>()((set, get) => {
		/** Apply a structural change: new layout, still-valid active tab, dirty. */
		function change(next: (layout: ProjectLayout) => ProjectLayout) {
			set((state) => {
				const layout = next(state.layout);
				const history = pruneHistory(state.tabHistory, layout);
				const activeTabId = pickActive(layout, state.activeTabId, history);
				return {
					layout,
					activeTabId,
					tabHistory: remember(history, activeTabId),
					dirty: true,
				};
			});
		}

		return {
			layout: tree.emptyLayout(),
			activeTabId: null,
			focusedTerminalId: null,
			pendingLine: {},
			pendingDiff: {},
			pendingEdit: {},
			viewStates: {},
			zooms: {},
			tabHistory: [],
			dirty: false,

			load: (saved) =>
				set((state) => {
					// A layout saved before diffs became a view of the file tab
					// still has diff tabs; they become file tabs showing a diff.
					const { layout, diffTabIds } = tree.migrateDiffTabs(saved);
					const pendingDiff = { ...state.pendingDiff };
					for (const tabId of diffTabIds) {
						pendingDiff[tabId] = (pendingDiff[tabId] ?? 0) + 1;
					}
					const history = pruneHistory(state.tabHistory, layout);
					const activeTabId = pickActive(layout, state.activeTabId, history);
					return {
						layout,
						activeTabId,
						tabHistory: remember(history, activeTabId),
						pendingDiff,
						dirty: layout !== saved,
					};
				}),

			addTab: (terminalId) => {
				// A tab is named after the terminal it was opened for.
				set((state) => ({
					layout: tree.addTab(place(state.layout, terminalId), terminalId, terminalId),
					activeTabId: terminalId,
					tabHistory: remember(state.tabHistory, terminalId),
					dirty: true,
				}));
			},

			openFile: (path, options) => {
				const state = get();
				const opened = tree.openFile(state.layout, path);
				if (!opened) return false;
				const line = options?.line;
				const pendingLine = { ...state.pendingLine };
				// Always write the key, so a stale line from an earlier open goes.
				if (line === undefined) delete pendingLine[opened.tabId];
				else pendingLine[opened.tabId] = line;
				// Exactly one of the two is asked for, so a tab left in diff view
				// goes back to the editor when the file is opened again.
				const pendingDiff = { ...state.pendingDiff };
				const pendingEdit = { ...state.pendingEdit };
				if (options?.diff) {
					pendingDiff[opened.tabId] = (pendingDiff[opened.tabId] ?? 0) + 1;
					delete pendingEdit[opened.tabId];
				} else {
					pendingEdit[opened.tabId] = (pendingEdit[opened.tabId] ?? 0) + 1;
					delete pendingDiff[opened.tabId];
				}
				set({
					layout: opened.layout,
					activeTabId: opened.tabId,
					tabHistory: remember(state.tabHistory, opened.tabId),
					pendingLine,
					pendingDiff,
					pendingEdit,
					dirty: state.dirty || opened.layout !== state.layout,
				});
				return true;
			},

			closeTab: (tabId) => {
				const tabs = get().layout.tabs;
				const index = tabs.findIndex((tab) => tab.id === tabId);
				const closing = tabs[index];
				if (!closing) return;
				set((state) => {
					const layout = tree.closeTab(state.layout, tabId);
					const tabHistory = pruneHistory(state.tabHistory, layout);
					const stillThere =
						state.activeTabId !== null &&
						layout.tabs.some((tab) => tab.id === state.activeTabId);
					// Closing another tab leaves the student where they are. Closing
					// the active one goes back to the tab that was active before it,
					// then to the neighbour on the left, then the one on the right
					// (issue #223). After the removal `index` is the right neighbour.
					const activeTabId = stillThere
						? state.activeTabId
						: (tabHistory[0] ??
							layout.tabs[index - 1]?.id ??
							layout.tabs[index]?.id ??
							null);
					const { [tabId]: _line, ...pendingLine } = state.pendingLine;
					const { [tabId]: _diff, ...pendingDiff } = state.pendingDiff;
					const { [tabId]: _edit, ...pendingEdit } = state.pendingEdit;
					const viewStates = { ...state.viewStates };
					const zooms = { ...state.zooms };
					// Nothing to put back next time: the file tab is gone.
					if (closing.root.type === "file") {
						delete viewStates[closing.root.path];
						delete zooms[closing.root.path];
					}
					return {
						layout,
						activeTabId,
						tabHistory: remember(tabHistory, activeTabId),
						pendingLine,
						pendingDiff,
						pendingEdit,
						viewStates,
						zooms,
						dirty: true,
					};
				});
			},

			consumePendingLine: (tabId) => {
				const line = get().pendingLine[tabId];
				if (line !== undefined) {
					set((state) => {
						const { [tabId]: _gone, ...rest } = state.pendingLine;
						return { pendingLine: rest };
					});
				}
				return line;
			},

			consumePendingDiff: (tabId) => {
				const asked = get().pendingDiff[tabId] !== undefined;
				if (asked) {
					set((state) => {
						const { [tabId]: _gone, ...rest } = state.pendingDiff;
						return { pendingDiff: rest };
					});
				}
				return asked;
			},

			consumePendingEdit: (tabId) => {
				const asked = get().pendingEdit[tabId] !== undefined;
				if (asked) {
					set((state) => {
						const { [tabId]: _gone, ...rest } = state.pendingEdit;
						return { pendingEdit: rest };
					});
				}
				return asked;
			},

			splitLeaf: (terminalId, direction, newTerminalId) =>
				change((layout) =>
					tree.splitLeaf(
						place(layout, newTerminalId),
						terminalId,
						direction,
						newTerminalId,
					),
				),

			removeLeaf: (terminalId) =>
				change((layout) => tree.removeLeaf(layout, terminalId)),

			replaceLeaf: (terminalId, newTerminalId) =>
				change((layout) =>
					tree.replaceLeaf(place(layout, newTerminalId), terminalId, newTerminalId),
				),

			moveTab: (from, to) => change((layout) => tree.moveTab(layout, from, to)),

			// A pane dragged into another tab follows the drag, so show that tab.
			moveLeaf: (tabId, terminalId, targetTerminalId, edge) =>
				set((state) => {
					const layout = tree.moveLeaf(
						state.layout,
						tabId,
						terminalId,
						targetTerminalId,
						edge,
					);
					if (layout === state.layout) return state;
					return {
						layout,
						activeTabId: tabId,
						tabHistory: remember(pruneHistory(state.tabHistory, layout), tabId),
						dirty: true,
					};
				}),

			moveLeafToNewTab: (terminalId, index) =>
				set((state) => {
					// A fresh id: the tab this pane is leaving may already be named
					// after the terminal, and two tabs cannot share an id.
					const tabId = crypto.randomUUID();
					const layout = tree.moveLeafToNewTab(state.layout, terminalId, index, tabId);
					if (layout === state.layout) return state;
					return {
						layout,
						activeTabId: tabId,
						tabHistory: remember(pruneHistory(state.tabHistory, layout), tabId),
						dirty: true,
					};
				}),

			resize: (tabId, path, sizes) =>
				change((layout) => tree.resize(layout, tabId, path, sizes)),

			setActive: (tabId) =>
				set((state) => ({
					activeTabId: tabId,
					tabHistory: remember(state.tabHistory, tabId),
				})),

			setViewState: (path, viewState) =>
				set((state) => ({ viewStates: { ...state.viewStates, [path]: viewState } })),

			setZoom: (path, percent) =>
				set((state) => ({ zooms: { ...state.zooms, [path]: percent } })),

			// The saved layout usually arrives after this, and its load keeps an
			// active tab that still exists, so the remembered tab survives.
			restoreLocal: (local) =>
				set((state) => {
					const activeTabId = local.activeTabId ?? state.activeTabId;
					return {
						activeTabId,
						tabHistory: remember(state.tabHistory, activeTabId),
						viewStates: { ...local.viewStates, ...state.viewStates },
					};
				}),

			setFocused: (terminalId) => set({ focusedTerminalId: terminalId }),

			reconcile: (terminalIds, endedIds) =>
				set((state) => {
					const layout = tree.reconcile(state.layout, terminalIds, endedIds);
					if (layout === state.layout) return state;
					const history = pruneHistory(state.tabHistory, layout);
					const activeTabId = pickActive(layout, state.activeTabId, history);
					return {
						layout,
						activeTabId,
						tabHistory: remember(history, activeTabId),
						dirty: true,
					};
				}),

			clearDirty: () => set({ dirty: false }),
		};
	});
}

/**
 * The store of the project on screen, shared by the work area and the file
 * tree: the tree opens file tabs in the same layout the work area draws.
 * The workspace screen provides it; a component rendered on its own still
 * gets a store of its own.
 */
export const LayoutStoreContext = createContext<LayoutStore | null>(null);

/**
 * One store per project id. Switching projects hands back a fresh store, so
 * tabs, splits and focus start from that project's own saved layout.
 */
export function useLayoutStore(projectId: string): LayoutStore {
	const shared = useContext(LayoutStoreContext);
	const held = useRef<{ projectId: string; store: LayoutStore } | null>(null);
	if (held.current === null || held.current.projectId !== projectId) {
		held.current = { projectId, store: createLayoutStore() };
	}
	return shared ?? held.current.store;
}

/**
 * The remembered cursor and scroll position of one open file, and a way to
 * put the newest one back (issue #161). `initial` is read once, when the tab
 * mounts, so later saves do not make the editor jump. A file tab rendered
 * outside a workspace has no store and simply remembers nothing.
 */
export function useEditorViewState(path: string): {
	initial: unknown;
	save: (viewState: unknown) => void;
} {
	const store = useContext(LayoutStoreContext);
	const initial = useRef<{ read: boolean; value: unknown }>({
		read: false,
		value: undefined,
	});
	if (!initial.current.read) {
		initial.current = { read: true, value: store?.getState().viewStates[path] };
	}
	const save = useCallback(
		(viewState: unknown) => store?.getState().setViewState(path, viewState),
		[store, path],
	);
	return { initial: initial.current.value, save };
}

/**
 * The editor zoom of one open file (issue #162). It is held in the layout
 * store, beside the cursor and scroll position, so there is one place that
 * remembers what a tab looked like; unlike those it is never written to this
 * browser's storage, so a reload starts at 100% again. A file tab rendered
 * outside a workspace has no store and simply keeps its own zoom.
 */
export function useEditorZoom(path: string): [number, (percent: number) => void] {
	const store = useContext(LayoutStoreContext);
	const [zoom, setLocal] = useState(
		() => store?.getState().zooms[path] ?? DEFAULT_ZOOM,
	);
	const set = useCallback(
		(percent: number) => {
			setLocal(percent);
			store?.getState().setZoom(path, percent);
		},
		[store, path],
	);
	return [zoom, set];
}

/** Read one slice of a layout store. */
export function useLayout<T>(store: LayoutStore, select: (state: LayoutState) => T): T {
	return useStore(store, select);
}
