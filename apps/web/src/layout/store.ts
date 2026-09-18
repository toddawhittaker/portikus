/**
 * The live copy of one project's layout (SPEC.md §7.5). One store per
 * project: switching project mounts a new one, so nothing carries over.
 * `dirty` marks a structural change the persistence hook still has to save;
 * the active tab and the focused pane are local to this browser and are
 * never saved.
 */
import type { ProjectLayout } from "@portikus/contracts";
import { createContext, useContext, useRef } from "react";
import { createStore, useStore } from "zustand";
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
	dirty: boolean;
	/** Replace the whole layout with what the server had saved. */
	load: (layout: ProjectLayout) => void;
	addTab: (terminalId: string) => void;
	/**
	 * Open a file tab, or activate the one already open for this path. False
	 * when there is no room for another tab, so the caller can say so.
	 */
	openFile: (path: string, line?: number) => boolean;
	/** Open a diff tab, or activate the one already open. False when full. */
	openDiff: (path: string) => boolean;
	/** Close one whole tab. Terminal tabs close by closing their terminals. */
	closeTab: (tabId: string) => void;
	/** Read and forget the line a file tab was asked to jump to. */
	consumePendingLine: (tabId: string) => number | undefined;
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

/** Keep the active tab pointing at a tab that still exists. */
function pickActive(layout: ProjectLayout, current: string | null): string | null {
	if (current && layout.tabs.some((tab) => tab.id === current)) return current;
	return layout.tabs[0]?.id ?? null;
}

export function createLayoutStore() {
	return createStore<LayoutState>()((set, get) => {
		/** Apply a structural change: new layout, still-valid active tab, dirty. */
		function change(next: (layout: ProjectLayout) => ProjectLayout) {
			set((state) => {
				const layout = next(state.layout);
				return {
					layout,
					activeTabId: pickActive(layout, state.activeTabId),
					dirty: true,
				};
			});
		}

		return {
			layout: tree.emptyLayout(),
			activeTabId: null,
			focusedTerminalId: null,
			pendingLine: {},
			dirty: false,

			load: (layout) =>
				set((state) => ({
					layout,
					activeTabId: pickActive(layout, state.activeTabId),
					dirty: false,
				})),

			addTab: (terminalId) => {
				// A tab is named after the terminal it was opened for.
				set((state) => ({
					layout: tree.addTab(place(state.layout, terminalId), terminalId, terminalId),
					activeTabId: terminalId,
					dirty: true,
				}));
			},

			openFile: (path, line) => {
				const state = get();
				const opened = tree.openFile(state.layout, path);
				if (!opened) return false;
				const pendingLine = { ...state.pendingLine };
				// Always write the key, so a stale line from an earlier open goes.
				if (line === undefined) delete pendingLine[opened.tabId];
				else pendingLine[opened.tabId] = line;
				set({
					layout: opened.layout,
					activeTabId: opened.tabId,
					pendingLine,
					dirty: state.dirty || opened.layout !== state.layout,
				});
				return true;
			},

			openDiff: (path) => {
				const state = get();
				const opened = tree.openDiff(state.layout, path);
				if (!opened) return false;
				set({
					layout: opened.layout,
					activeTabId: opened.tabId,
					dirty: state.dirty || opened.layout !== state.layout,
				});
				return true;
			},

			closeTab: (tabId) => {
				change((layout) => tree.closeTab(layout, tabId));
				set((state) => {
					const { [tabId]: _gone, ...rest } = state.pendingLine;
					return { pendingLine: rest };
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
					return { layout, activeTabId: tabId, dirty: true };
				}),

			moveLeafToNewTab: (terminalId, index) =>
				set((state) => {
					// A fresh id: the tab this pane is leaving may already be named
					// after the terminal, and two tabs cannot share an id.
					const tabId = crypto.randomUUID();
					const layout = tree.moveLeafToNewTab(state.layout, terminalId, index, tabId);
					if (layout === state.layout) return state;
					return { layout, activeTabId: tabId, dirty: true };
				}),

			resize: (tabId, path, sizes) =>
				change((layout) => tree.resize(layout, tabId, path, sizes)),

			setActive: (tabId) => set({ activeTabId: tabId }),

			setFocused: (terminalId) => set({ focusedTerminalId: terminalId }),

			reconcile: (terminalIds, endedIds) =>
				set((state) => {
					const layout = tree.reconcile(state.layout, terminalIds, endedIds);
					if (layout === state.layout) return state;
					return {
						layout,
						activeTabId: pickActive(layout, state.activeTabId),
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

/** Read one slice of a layout store. */
export function useLayout<T>(store: LayoutStore, select: (state: LayoutState) => T): T {
	return useStore(store, select);
}
