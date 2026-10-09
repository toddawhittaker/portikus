/**
 * The live copy of one project's layout (SPEC.md §7.5). One store per
 * project: switching project mounts a new one, so nothing carries over.
 * `dirty` marks a structural change the persistence hook still has to save;
 * the active tab, the editor view states and the focused pane are local to
 * this browser and are kept in localStorage instead (local.ts).
 */
import type { ProjectLayout } from "@portikus/contracts";
import { createContext, useCallback, useContext, useRef, useState } from "react";
import { createStore, useStore } from "zustand";
import { DEFAULT_ZOOM } from "../editor/zoom.js";
import { isDescendant, movedPath } from "../files/paths.js";
import type { LocalLayout } from "./local.js";
import * as tree from "./tree.js";

/** One request for a file pane: show the diff or the editor, maybe at a line. */
export interface PendingView {
	mode: "diff" | "edit";
	line?: number;
	seq: number;
}

export interface LayoutState {
	layout: ProjectLayout;
	activeTabId: string | null;
	focusedTerminalId: string | null;
	/**
	 * What each file pane was last asked to show, by its pane id
	 * (`file:<path>`, wherever the pane sits): its diff or its editor, and
	 * optionally a line to jump to. `seq` makes a repeat of the same request a
	 * new one. A one-off request from this browser, never saved.
	 */
	pendingView: Record<string, PendingView>;
	/**
	 * Monaco's view state (cursor, selections, scroll) for each open file, by
	 * project-relative path. It belongs to this browser, so it is kept beside
	 * the layout rather than in the saved document.
	 */
	viewStates: Record<string, unknown>;
	/**
	 * The editor zoom of each open file, by project-relative path. It
	 * lasts the session only, so this one lives here and is
	 * never written to this browser's storage.
	 */
	zooms: Record<string, number>;
	/**
	 * The tabs that have been active, newest first, so closing a tab can go
	 * back to the one before it the way a browser does. It only
	 * matters while this workspace is open, so it is neither saved to the
	 * server nor written to this browser's storage.
	 */
	tabHistory: string[];
	/**
	 * Which file panes have edits that are not on disk, by pane id. The tab
	 * strip shows a dot instead of the close button on a tab holding any of
	 * them. It is what the editor is holding right now, so it is never saved
	 * anywhere.
	 */
	unsavedTabs: Record<string, boolean>;
	dirty: boolean;
	/** Replace the whole layout with what the server had saved. */
	load: (layout: ProjectLayout) => void;
	addTab: (terminalId: string) => void;
	/**
	 * Object id a file pane's diff compares against, or null for Git HEAD, by
	 * pane id. Local to this browser (SPEC.md §12.7).
	 */
	diffBaseline: Record<string, string | null>;
	/**
	 * Open a file tab, or activate the tab already showing this path, alone or
	 * in a split. With `diff` the pane is asked to show its diff rather than
	 * the editor.
	 * `baseline` compares that diff with an object id instead
	 * of Git HEAD. There is no limit on open tabs.
	 */
	openFile: (
		path: string,
		options?: { line?: number; diff?: boolean; baseline?: string },
	) => void;
	/**
	 * Open a preview tab for one port, or activate the one already open for
	 * it (SPEC.md §14.6). There is no limit on open tabs.
	 */
	openPreview: (port: number) => void;
	/** Close one whole tab. Terminal tabs close by closing their terminals. */
	closeTab: (tabId: string) => void;
	/** Close one file's pane, whether it is a tab of its own or in a split. */
	closeFile: (path: string) => void;
	/** Record whether one file pane, by pane id, has unsaved edits. */
	setTabUnsaved: (paneId: string, unsaved: boolean) => void;
	/** Read and forget what a file pane, by pane id, was asked to show. */
	consumePendingView: (paneId: string) => PendingView | undefined;
	splitLeaf: (
		terminalId: string,
		direction: tree.SplitDirection,
		newTerminalId: string,
	) => void;
	/** Drop one pane by its pane id: a terminal id, or `file:<path>`. */
	removeLeaf: (paneId: string) => void;
	replaceLeaf: (terminalId: string, newTerminalId: string) => void;
	moveTab: (from: number, to: number) => void;
	/** Drag one pane, a terminal or a file, onto another (SPEC.md §9.3). */
	moveLeaf: (
		tabId: string,
		paneId: string,
		targetPaneId: string,
		edge: tree.DropEdge,
	) => void;
	/** Drag one pane out to the tab strip, where it becomes its own tab. */
	moveLeafToNewTab: (paneId: string, index: number) => void;
	resize: (tabId: string, path: number[], sizes: number[]) => void;
	setActive: (tabId: string) => void;
	/** Remember where the cursor and scroll are in one open file. */
	setViewState: (path: string, viewState: unknown) => void;
	/** Remember the editor zoom of one open file for this session. */
	setZoom: (path: string, percent: number) => void;
	/** Put back what this browser remembered for this project. */
	restoreLocal: (local: LocalLayout) => void;
	setFocused: (terminalId: string | null) => void;
	/**
	 * Follow a rename or move made from the files pane (SPEC.md §11.2): every
	 * open file under `from` keeps its pane, now showing its place under
	 * `to`, with its diff baseline, unsaved mark, view state, zoom and
	 * unsaved text.
	 */
	retargetTabs: (from: string, to: string) => void;
	/**
	 * A mounted file pane's editor offers its unsaved text, so a move can carry
	 * it to the pane's new path. `snapshot` answers null when nothing is
	 * unsaved. The returned release answers false when a move already took the
	 * text, so the unmounting editor leaves it alone.
	 */
	registerBuffer: (path: string, snapshot: () => unknown) => () => boolean;
	/**
	 * Keep one editor's unsaved text while its pane remounts, as a move into
	 * or out of a split does (SPEC.md §13.5). Kept only while the file is
	 * still open, so a closed tab leaves nothing behind.
	 */
	carryBuffer: (path: string, carried: unknown) => void;
	/** Take the unsaved text kept for `path`, once. */
	takeBuffer: (path: string) => unknown;
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
 * The id a tab has after a change. A tab can be renamed when a file's pane
 * leaves it or joins it (tree.ts, settleTabIds), so a tab that is gone is
 * followed through the panes it held; `paneNow` gives a pane's id after the
 * change, for a file that moved. Unchanged when nothing matches.
 */
function followTab(
	before: ProjectLayout,
	after: ProjectLayout,
	tabId: string,
	paneNow: (paneId: string) => string = (paneId) => paneId,
): string {
	if (after.tabs.some((tab) => tab.id === tabId)) return tabId;
	const old = before.tabs.find((tab) => tab.id === tabId);
	if (!old) return tabId;
	for (const id of tree.paneIds(old.root)) {
		const now = tree.tabOfPane(after, paneNow(id));
		if (now !== null) return now;
	}
	return tabId;
}

/** Drop the per-file state of files that are no longer open. */
function forgetFiles(
	state: LayoutState,
	paths: string[],
): Pick<LayoutState, "pendingView" | "diffBaseline" | "viewStates" | "zooms"> {
	const pendingView = { ...state.pendingView };
	const diffBaseline = { ...state.diffBaseline };
	const viewStates = { ...state.viewStates };
	const zooms = { ...state.zooms };
	for (const path of paths) {
		const id = tree.fileTabId(path);
		delete pendingView[id];
		delete diffBaseline[id];
		delete viewStates[path];
		delete zooms[path];
	}
	return { pendingView, diffBaseline, viewStates, zooms };
}

/**
 * Rewrite the keys of a per-file record after `from` moved to `to`. `prefix`
 * is what comes before the path in a key. Whatever was kept for a file the
 * move replaced at `to` is dropped.
 */
function moveKeys<T>(
	record: Record<string, T>,
	prefix: string,
	from: string,
	to: string,
): Record<string, T> {
	const kept: Record<string, T> = {};
	const moved: Record<string, T> = {};
	for (const [key, value] of Object.entries(record)) {
		if (!key.startsWith(prefix)) {
			kept[key] = value;
			continue;
		}
		const path = key.slice(prefix.length);
		const now = movedPath(path, from, to);
		if (now !== null) moved[prefix + now] = value;
		else if (path !== to && !isDescendant(path, to)) kept[key] = value;
	}
	return { ...kept, ...moved };
}

/**
 * Keep the active tab pointing at a tab that still exists, preferring the one
 * that was active most recently.
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
		let seq = 0;
		const nextSeq = () => ++seq;
		// Editors' unsaved text, by path. It is what the editor holds right
		// now, so it lives beside the state rather than in it, and is never saved.
		const liveBuffers = new Map<string, () => unknown>();
		const carried = new Map<string, unknown>();

		/** Forget the unsaved text kept for files that were closed. */
		function dropCarried(paths: string[]) {
			for (const path of paths) carried.delete(path);
		}

		/**
		 * The active tab and history after a change, following a tab that was
		 * renamed rather than dropping it.
		 */
		function settleActive(
			state: LayoutState,
			layout: ProjectLayout,
			paneNow?: (paneId: string) => string,
		) {
			const follow = (id: string) => followTab(state.layout, layout, id, paneNow);
			const history = pruneHistory(state.tabHistory.map(follow), layout);
			const current = state.activeTabId === null ? null : follow(state.activeTabId);
			const activeTabId = pickActive(layout, current, history);
			return { activeTabId, tabHistory: remember(history, activeTabId) };
		}

		/** Apply a structural change: new layout, still-valid active tab, dirty. */
		function change(next: (layout: ProjectLayout) => ProjectLayout) {
			set((state) => {
				const layout = next(state.layout);
				return { layout, ...settleActive(state, layout), dirty: true };
			});
		}

		/** Show the tab a moved pane landed in. */
		function showMoved(state: LayoutState, layout: ProjectLayout, paneId: string) {
			if (layout === state.layout) return state;
			const settled = settleActive(state, layout);
			const activeTabId = tree.tabOfPane(layout, paneId) ?? settled.activeTabId;
			return {
				layout,
				activeTabId,
				tabHistory: remember(settled.tabHistory, activeTabId),
				dirty: true,
			};
		}

		return {
			layout: tree.emptyLayout(),
			activeTabId: null,
			focusedTerminalId: null,
			pendingView: {},
			diffBaseline: {},
			viewStates: {},
			zooms: {},
			tabHistory: [],
			unsavedTabs: {},
			dirty: false,

			load: (saved) =>
				set((state) => {
					// A layout saved before diffs became a view of the file tab
					// still has diff tabs; they become file tabs showing a diff.
					const { layout, diffTabIds } = tree.migrateDiffTabs(saved);
					const pendingView = { ...state.pendingView };
					for (const tabId of diffTabIds) {
						const line = pendingView[tabId]?.line;
						pendingView[tabId] = { mode: "diff", line, seq: nextSeq() };
					}
					const history = pruneHistory(state.tabHistory, layout);
					const activeTabId = pickActive(layout, state.activeTabId, history);
					return {
						layout,
						activeTabId,
						tabHistory: remember(history, activeTabId),
						pendingView,
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
				const pane = tree.fileTabId(path);
				// Exactly one of diff and editor is asked for, so a pane left in diff
				// view goes back to the editor when the file is opened again. A new
				// request replaces the old one, line included.
				const pendingView = { ...state.pendingView };
				pendingView[pane] = {
					mode: options?.diff ? "diff" : "edit",
					line: options?.line,
					seq: nextSeq(),
				};
				const diffBaseline = { ...state.diffBaseline };
				diffBaseline[pane] =
					options?.diff && options.baseline ? options.baseline : null;
				set({
					layout: opened.layout,
					activeTabId: opened.tabId,
					tabHistory: remember(state.tabHistory, opened.tabId),
					pendingView,
					diffBaseline,
					dirty: state.dirty || opened.layout !== state.layout,
				});
			},

			openPreview: (port) => {
				const state = get();
				const opened = tree.openPreview(state.layout, port);
				set({
					layout: opened.layout,
					activeTabId: opened.tabId,
					tabHistory: remember(state.tabHistory, opened.tabId),
					dirty: state.dirty || opened.layout !== state.layout,
				});
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
					// then to the neighbour on the left, then the one on the right.
					// After the removal `index` is the right neighbour.
					const activeTabId = stillThere
						? state.activeTabId
						: (tabHistory[0] ??
							layout.tabs[index - 1]?.id ??
							layout.tabs[index]?.id ??
							null);
					dropCarried(tree.filePaths(closing.root));
					return {
						layout,
						activeTabId,
						tabHistory: remember(tabHistory, activeTabId),
						// Nothing to put back next time: the files are gone.
						...forgetFiles(state, tree.filePaths(closing.root)),
						dirty: true,
					};
				});
			},

			closeFile: (path) => {
				const pane = tree.fileTabId(path);
				const tabId = tree.tabOfPane(get().layout, pane);
				if (tabId === null) return;
				// A file alone in its tab closes the way its tab does.
				if (tabId === pane) {
					get().closeTab(tabId);
					return;
				}
				set((state) => {
					const layout = tree.removeLeaf(state.layout, pane);
					dropCarried([path]);
					return {
						layout,
						...settleActive(state, layout),
						...forgetFiles(state, [path]),
						dirty: true,
					};
				});
			},

			consumePendingView: (paneId) => {
				const view = get().pendingView[paneId];
				if (view !== undefined) {
					set((state) => {
						const { [paneId]: _gone, ...rest } = state.pendingView;
						return { pendingView: rest };
					});
				}
				return view;
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

			removeLeaf: (paneId) => change((layout) => tree.removeLeaf(layout, paneId)),

			replaceLeaf: (terminalId, newTerminalId) =>
				change((layout) =>
					tree.replaceLeaf(place(layout, newTerminalId), terminalId, newTerminalId),
				),

			moveTab: (from, to) => change((layout) => tree.moveTab(layout, from, to)),

			// A pane dragged into another tab follows the drag, so show that tab.
			moveLeaf: (tabId, paneId, targetPaneId, edge) =>
				set((state) =>
					showMoved(
						state,
						tree.moveLeaf(state.layout, tabId, paneId, targetPaneId, edge),
						paneId,
					),
				),

			moveLeafToNewTab: (paneId, index) =>
				set((state) => {
					// A fresh id: the tab this pane is leaving may already be named
					// after the terminal, and two tabs cannot share an id.
					const tabId = crypto.randomUUID();
					const layout = tree.moveLeafToNewTab(state.layout, paneId, index, tabId);
					return showMoved(state, layout, paneId);
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

			retargetTabs: (from, to) => {
				// The editors under `from` unmount once the layout changes, so
				// their text is taken now and waits for the panes at the new paths.
				for (const [path, snapshot] of [...liveBuffers]) {
					const now = movedPath(path, from, to);
					if (now === null) continue;
					liveBuffers.delete(path);
					const text = snapshot();
					if (text !== null) carried.set(now, text);
				}
				for (const [path, text] of [...carried]) {
					const now = movedPath(path, from, to);
					if (now === null) continue;
					carried.delete(path);
					carried.set(now, text);
				}
				set((state) => {
					const layout = tree.retargetFiles(state.layout, from, to);
					const files = tree.fileTabId("");
					// A lone file's tab is renamed with its file.
					const paneNow = (pane: string): string => {
						const moved = pane.startsWith(files)
							? movedPath(pane.slice(files.length), from, to)
							: null;
						return moved === null ? pane : tree.fileTabId(moved);
					};
					return {
						layout,
						...settleActive(state, layout, paneNow),
						pendingView: moveKeys(state.pendingView, files, from, to),
						diffBaseline: moveKeys(state.diffBaseline, files, from, to),
						unsavedTabs: moveKeys(state.unsavedTabs, files, from, to),
						viewStates: moveKeys(state.viewStates, "", from, to),
						zooms: moveKeys(state.zooms, "", from, to),
						dirty: state.dirty || layout !== state.layout,
					};
				});
			},

			registerBuffer: (path, snapshot) => {
				liveBuffers.set(path, snapshot);
				return () => {
					if (liveBuffers.get(path) !== snapshot) return false;
					liveBuffers.delete(path);
					return true;
				};
			},

			carryBuffer: (path, text) => {
				if (tree.tabOfPane(get().layout, tree.fileTabId(path)) === null) return;
				carried.set(path, text);
			},

			takeBuffer: (path) => {
				const text = carried.get(path);
				carried.delete(path);
				return text;
			},

			reconcile: (terminalIds, endedIds) =>
				set((state) => {
					const layout = tree.reconcile(state.layout, terminalIds, endedIds);
					if (layout === state.layout) return state;
					return { layout, ...settleActive(state, layout), dirty: true };
				}),

			setTabUnsaved: (paneId, unsaved) =>
				set((state) => {
					if ((state.unsavedTabs[paneId] ?? false) === unsaved) return state;
					const next = { ...state.unsavedTabs };
					if (unsaved) next[paneId] = true;
					else delete next[paneId];
					return { unsavedTabs: next };
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
 * put the newest one back. `initial` is read once, when the tab
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
 * The editor zoom of one open file. It is held in the layout
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
