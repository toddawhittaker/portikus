/**
 * The live copy of one project's layout (SPEC.md §7.5). One store per
 * project: switching project mounts a new one, so nothing carries over.
 * `dirty` marks a structural change the persistence hook still has to save;
 * the active tab and the focused pane are local to this browser and are
 * never saved.
 */
import type { ProjectLayout } from "@portikus/contracts";
import { useRef } from "react";
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
	/** Open a file tab, or activate the one already open for this path. */
	openFile: (path: string, line?: number) => void;
	/** Open a diff tab, or activate the one already open for this path. */
	openDiff: (path: string) => void;
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

			openFile: (path, line) =>
				set((state) => {
					const opened = tree.openFile(state.layout, path);
					const pendingLine =
						line === undefined
							? state.pendingLine
							: { ...state.pendingLine, [opened.tabId]: line };
					return {
						layout: opened.layout,
						activeTabId: opened.tabId,
						pendingLine,
						dirty: state.dirty || opened.layout !== state.layout,
					};
				}),

			openDiff: (path) =>
				set((state) => {
					const opened = tree.openDiff(state.layout, path);
					return {
						layout: opened.layout,
						activeTabId: opened.tabId,
						dirty: state.dirty || opened.layout !== state.layout,
					};
				}),

			closeTab: (tabId) => change((layout) => tree.closeTab(layout, tabId)),

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
 * One store per project id. Switching projects hands back a fresh store, so
 * tabs, splits and focus start from that project's own saved layout.
 */
export function useLayoutStore(projectId: string): LayoutStore {
	const held = useRef<{ projectId: string; store: LayoutStore } | null>(null);
	if (held.current === null || held.current.projectId !== projectId) {
		held.current = { projectId, store: createLayoutStore() };
	}
	return held.current.store;
}

/** Read one slice of a layout store. */
export function useLayout<T>(store: LayoutStore, select: (state: LayoutState) => T): T {
	return useStore(store, select);
}
