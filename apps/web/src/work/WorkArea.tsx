/**
 * The centre work area: the terminal tabs, their splits, and the saved
 * layout of one project (SPEC.md §7.5, §8, §9.3). Files, previews and coding
 * agents get their own tab kinds in later epics; their launcher entries are
 * here but disabled.
 */
import {
	DndContext,
	type DragMoveEvent,
	DragOverlay,
	PointerSensor,
	pointerWithin,
	useDroppable,
	useSensor,
	useSensors,
} from "@dnd-kit/core";
import type { Terminal } from "@portikus/contracts";
import {
	ConfirmDialog,
	ConfirmDialogRoot,
	EmptyState,
	IconButton,
	Menu,
	MenuItem,
	MenuLabel,
	MenuRoot,
	MenuSeparator,
	MenuTrigger,
	type TabItem,
	Tabs,
	useToast,
} from "@portikus/ui";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { tooManyTabsToast } from "../files/errors.js";
import { useLayoutPersistence } from "../layout/persist.js";
import { useLayout, useLayoutStore } from "../layout/store.js";
import { type DropEdge, type SplitDirection, terminalIds } from "../layout/tree.js";
import { PreviewPicker } from "../preview/PreviewPicker.js";
import { useShowRightPane } from "../shell/rightPane.js";
import { useTerminals } from "../useTerminals.js";
import { dropZone, insertionIndex } from "./dropZone.js";
import { TerminalGroup } from "./TerminalGroup.js";
import "./work.css";

/** The one droppable that covers the tab strip (SPEC.md §8.3). */
const TAB_STRIP_DROP_ID = "work-tab-strip";

/** Where a dragged pane would land, as the drag moves. */
type DragTarget =
	| { kind: "pane"; tabId: string; terminalId: string; edge: DropEdge }
	| { kind: "strip"; index: number; markerX: number };

/** The tab strip as a drop area; separate so it can use `useDroppable`. */
function TabStripDrop({ children }: { children: ReactNode }) {
	const drop = useDroppable({ id: TAB_STRIP_DROP_ID });
	return (
		<div className="pk-work-tabs-drop" ref={drop.setNodeRef}>
			{children}
		</div>
	);
}

export interface WorkAreaProps {
	workspaceId: string;
	projectId: string;
	projectPath: string;
	/** A file the URL asked to open, and the line to jump to (SPEC.md §14.9). */
	openPath?: string;
	openLine?: number;
	/** A port the URL asked to preview (SPEC.md §14.6, §14.9). */
	openPreviewPort?: number;
	onSessionEnded: () => void;
}

export function WorkArea({
	workspaceId,
	projectId,
	projectPath,
	openPath,
	openLine,
	openPreviewPort,
	onSessionEnded,
}: WorkAreaProps) {
	const store = useLayoutStore(projectId);
	const toast = useToast();
	const layout = useLayout(store, (state) => state.layout);
	const activeTabId = useLayout(store, (state) => state.activeTabId);
	const focusedTerminalId = useLayout(store, (state) => state.focusedTerminalId);
	const pendingLine = useLayout(store, (state) => state.pendingLine);
	const pendingDiff = useLayout(store, (state) => state.pendingDiff);
	const pendingEdit = useLayout(store, (state) => state.pendingEdit);
	const loaded = useLayoutPersistence(workspaceId, projectId, store, onSessionEnded);
	const terminals = useTerminals(workspaceId, projectId, true, onSessionEnded);
	const [closingTabId, setClosingTabId] = useState<string | null>(null);
	const [pickingPreview, setPickingPreview] = useState(false);
	const showRightPane = useShowRightPane();
	const [draggedPane, setDraggedPane] = useState<{
		terminalId: string;
		title: string;
	} | null>(null);
	const [dragTarget, setDragTarget] = useState<DragTarget | null>(null);
	const strip = useRef<HTMLDivElement | null>(null);

	const byId = new Map(terminals.terminals.map((terminal) => [terminal.id, terminal]));

	// Once the saved layout is in, every terminal list answer decides which
	// panes exist: new terminals get a tab, gone terminals lose their pane.
	// An ended terminal with no pane stays out of the way: it is history in the
	// listing, not a pane (SPEC.md §9.7). The two joined id lists are the
	// effect's keys, so it re-runs when a terminal appears, goes, or ends.
	const terminalIdKey = terminals.terminals.map((terminal) => terminal.id).join(",");
	const endedTerminalIds = terminals.terminals
		.filter((terminal) => terminal.endedAt != null)
		.map((terminal) => terminal.id)
		.join(",");
	useEffect(() => {
		if (!loaded || !terminals.loaded) return;
		const ids = terminalIdKey === "" ? [] : terminalIdKey.split(",");
		const ended = endedTerminalIds === "" ? [] : endedTerminalIds.split(",");
		store.getState().reconcile(ids, ended);
	}, [loaded, terminals.loaded, terminalIdKey, endedTerminalIds, store]);

	// A file the URL named opens once the saved layout is in, because loading
	// it would otherwise replace the tab this just opened.
	useEffect(() => {
		if (!loaded || !openPath) return;
		if (!store.getState().openFile(openPath, { line: openLine })) {
			toast.show(tooManyTabsToast());
		}
	}, [loaded, openPath, openLine, store, toast]);

	// A preview the URL named opens once the saved layout is in, for the same
	// reason a file does.
	useEffect(() => {
		if (!loaded || openPreviewPort === undefined) return;
		if (!store.getState().openPreview(openPreviewPort)) {
			toast.show(tooManyTabsToast());
		}
	}, [loaded, openPreviewPort, store, toast]);

	const newTerminal = useCallback(async (): Promise<Terminal | null> => {
		try {
			return await terminals.create();
		} catch {
			return null;
		}
	}, [terminals]);

	// Place the new terminal before the list is refetched, so no reconcile ever
	// sees a terminal that has no pane yet and gives it a tab of its own.
	async function createAndPlace(place: (created: Terminal) => void) {
		const created = await newTerminal();
		if (!created) return;
		place(created);
		terminals.refetch();
	}

	async function openTerminalTab() {
		await createAndPlace((created) => store.getState().addTab(created.id));
	}

	async function split(terminalId: string, direction: SplitDirection) {
		await createAndPlace((created) =>
			store.getState().splitLeaf(terminalId, direction, created.id),
		);
	}

	async function replace(terminalId: string) {
		await createAndPlace((created) =>
			store.getState().replaceLeaf(terminalId, created.id),
		);
	}

	/**
	 * Delete the terminal and let the refreshed list remove the pane. The pane
	 * may stay for one round trip; a failure shows the terminals error line.
	 */
	function closeTerminal(terminalId: string) {
		void terminals.close(terminalId).catch(() => {});
	}

	function closeTab(tabId: string) {
		const tab = layout.tabs.find((item) => item.id === tabId);
		if (!tab) return;
		// A file, diff or preview tab holds no process, so closing it is just
		// the tab.
		if (
			tab.root.type === "file" ||
			tab.root.type === "diff" ||
			tab.root.type === "preview"
		) {
			store.getState().closeTab(tabId);
			setClosingTabId(null);
			return;
		}
		for (const terminalId of terminalIds(tab.root)) closeTerminal(terminalId);
		setClosingTabId(null);
	}

	function requestCloseTab(tabId: string) {
		const tab = layout.tabs.find((item) => item.id === tabId);
		if (!tab) return;
		const live = terminalIds(tab.root).filter((id) => byId.get(id)?.endedAt == null);
		if (live.length > 1) {
			setClosingTabId(tabId);
			return;
		}
		closeTab(tabId);
	}

	// Mod+Alt+T opens a terminal from anywhere in the work area. The listener is
	// registered once; the ref keeps it pointed at the newest handler.
	const openTerminalTabRef = useRef(openTerminalTab);
	openTerminalTabRef.current = openTerminalTab;
	useEffect(() => {
		function onKeyDown(event: KeyboardEvent) {
			if (!event.altKey || !(event.ctrlKey || event.metaKey)) return;
			if (event.key.toLowerCase() !== "t") return;
			event.preventDefault();
			void openTerminalTabRef.current();
		}
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, []);

	/** Alt+Shift+Q leaves the terminal for the tab strip (DESIGN.md). */
	function leaveTerminal() {
		const tabs = strip.current?.querySelectorAll<HTMLElement>('[role="tab"]');
		if (!tabs) return;
		const index = layout.tabs.findIndex((tab) => tab.id === activeTabId);
		(tabs[index < 0 ? 0 : index] ?? tabs[0])?.focus();
	}

	const items: TabItem[] = layout.tabs.map((tab) => {
		if (tab.root.type === "preview") {
			const port = tab.root.port;
			return {
				id: tab.id,
				kind: "preview" as const,
				label: `Preview ${port}`,
				title: `Preview of port ${port}`,
				testId: `tab-${tab.id}`,
			};
		}
		if (tab.root.type === "file" || tab.root.type === "diff") {
			const path = tab.root.path;
			return {
				id: tab.id,
				kind: tab.root.type,
				// The strip has no room for a path, so the file name is the label.
				label: path.split("/").pop() ?? path,
				title: path,
				testId: `tab-${tab.id}`,
			};
		}
		const ids = terminalIds(tab.root);
		const first = ids[0] ? byId.get(ids[0]) : undefined;
		return {
			id: tab.id,
			kind: "terminal",
			label: first?.name ?? "Terminal",
			testId: `tab-${tab.id}`,
			ended: ids.length > 0 && ids.every((id) => byId.get(id)?.endedAt != null),
		};
	});

	const closingTab = layout.tabs.find((tab) => tab.id === closingTabId);

	// 4px so a click on a title bar still just focuses the pane, matching the
	// tab strip's own sensor.
	const sensors = useSensors(
		useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
	);

	/**
	 * Where the pointer is now. dnd-kit reports the pointer-down event and the
	 * distance dragged since, which together beat measuring the moving rect.
	 */
	function pointerOf(event: DragMoveEvent): { x: number; y: number } | null {
		const activator = event.activatorEvent;
		if (!(activator instanceof MouseEvent)) return null;
		return {
			x: activator.clientX + event.delta.x,
			y: activator.clientY + event.delta.y,
		};
	}

	/** The insertion point on the tab strip, and where to draw its marker. */
	function stripTargetAt(x: number): DragTarget | null {
		const container = strip.current;
		if (!container) return null;
		const rects = [...container.querySelectorAll<HTMLElement>('[role="tab"]')].map(
			(tab) => tab.getBoundingClientRect(),
		);
		const index = insertionIndex(rects, x);
		const box = container.getBoundingClientRect();
		const at = rects[index];
		const last = rects[rects.length - 1];
		const edge = at ? at.left : (last?.right ?? box.left);
		return { kind: "strip", index, markerX: edge - box.left };
	}

	function handleDragMove(event: DragMoveEvent) {
		const dragged = String(event.active.data.current?.terminalId ?? "");
		const pointer = pointerOf(event);
		const over = event.over;
		if (!over || !pointer) {
			setDragTarget(null);
			return;
		}
		if (over.id === TAB_STRIP_DROP_ID) {
			setDragTarget(stripTargetAt(pointer.x));
			return;
		}
		const terminalId = String(over.data.current?.terminalId ?? "");
		const tab = layout.tabs.find((item) => terminalIds(item.root).includes(terminalId));
		if (!terminalId || terminalId === dragged || !tab) {
			setDragTarget(null);
			return;
		}
		setDragTarget({
			kind: "pane",
			tabId: tab.id,
			terminalId,
			edge: dropZone(over.rect, pointer.x, pointer.y),
		});
	}

	function handleDragEnd() {
		const dragged = draggedPane?.terminalId;
		const target = dragTarget;
		setDraggedPane(null);
		setDragTarget(null);
		if (!dragged || !target) return;
		if (target.kind === "strip") {
			store.getState().moveLeafToNewTab(dragged, target.index);
			return;
		}
		store.getState().moveLeaf(target.tabId, dragged, target.terminalId, target.edge);
	}

	return (
		<DndContext
			sensors={sensors}
			collisionDetection={pointerWithin}
			onDragStart={(event) =>
				setDraggedPane({
					terminalId: String(event.active.data.current?.terminalId ?? ""),
					title: String(event.active.data.current?.title ?? ""),
				})
			}
			onDragMove={handleDragMove}
			onDragEnd={handleDragEnd}
			onDragCancel={() => {
				setDraggedPane(null);
				setDragTarget(null);
			}}
		>
			<div className="pk-work-area" data-testid="work-area">
				<TabStripDrop>
					<div className="pk-work-tabs" data-testid="work-tabs" ref={strip}>
						<Tabs
							tabs={items}
							activeId={activeTabId ?? ""}
							label={`Open tabs in ${projectPath}`}
							onSelect={(id) => store.getState().setActive(id)}
							onClose={requestCloseTab}
							onReorder={(from, to) => store.getState().moveTab(from, to)}
							actions={
								<MenuRoot>
									<MenuTrigger asChild={true}>
										<IconButton
											icon="plus"
											label="New"
											size="sm"
											data-testid="launcher"
											aria-haspopup="menu"
										/>
									</MenuTrigger>
									<Menu label="New tab">
										<MenuLabel>Open in {projectPath}</MenuLabel>
										<MenuItem
											icon="terminal"
											shortcut={["Mod", "Alt", "T"]}
											onSelect={() => void openTerminalTab()}
										>
											<span data-testid="launcher-terminal">Terminal</span>
										</MenuItem>
										<MenuItem icon="agent" disabled={true}>
											Claude Code — Epic 9
										</MenuItem>
										<MenuItem icon="agent" disabled={true}>
											Codex — Epic 9
										</MenuItem>
										<MenuSeparator />
										<MenuItem icon="file" disabled={true}>
											File — Epic 7
										</MenuItem>
										<MenuItem icon="preview" onSelect={() => setPickingPreview(true)}>
											<span data-testid="launcher-preview">Preview</span>
										</MenuItem>
									</Menu>
								</MenuRoot>
							}
						/>
						{dragTarget?.kind === "strip" ? (
							<div
								className="pk-tab-insert"
								data-testid="tab-insert-marker"
								data-index={dragTarget.index}
								style={{ left: `${dragTarget.markerX}px` }}
							/>
						) : null}
					</div>
				</TabStripDrop>

				{terminals.error ? (
					<p className="pk-work-error" role="alert">
						{terminals.error}
					</p>
				) : null}

				{layout.tabs.length === 0 ? (
					<EmptyState icon="terminal" title="No terminals open">
						Use New to open a terminal in {projectPath}.
					</EmptyState>
				) : (
					layout.tabs.map((tab) => (
						<TerminalGroup
							key={tab.id}
							tabId={tab.id}
							root={tab.root}
							terminals={byId}
							workspaceId={workspaceId}
							projectId={projectId}
							visible={tab.id === activeTabId}
							focusedTerminalId={focusedTerminalId}
							onFocus={(id) => store.getState().setFocused(id)}
							onSplit={(id, direction) => void split(id, direction)}
							onRename={(id, name) => void terminals.rename(id, name)}
							onClose={closeTerminal}
							onExited={closeTerminal}
							onReplace={(id) => void replace(id)}
							onResize={(path, sizes) => store.getState().resize(tab.id, path, sizes)}
							onSessionEnded={onSessionEnded}
							onShowRunning={() => showRightPane("running")}
							onLeave={leaveTerminal}
							onCloseTab={() => store.getState().closeTab(tab.id)}
							pendingLine={pendingLine[tab.id]}
							consumePendingLine={() => store.getState().consumePendingLine(tab.id)}
							pendingDiff={pendingDiff[tab.id]}
							consumePendingDiff={() => store.getState().consumePendingDiff(tab.id)}
							pendingEdit={pendingEdit[tab.id]}
							consumePendingEdit={() => store.getState().consumePendingEdit(tab.id)}
							dropTarget={
								dragTarget?.kind === "pane" && dragTarget.tabId === tab.id
									? { terminalId: dragTarget.terminalId, edge: dragTarget.edge }
									: null
							}
						/>
					))
				)}

				{pickingPreview ? (
					<PreviewPicker
						onClose={() => setPickingPreview(false)}
						onOpen={(port) => {
							setPickingPreview(false);
							if (!store.getState().openPreview(port)) toast.show(tooManyTabsToast());
						}}
					/>
				) : null}

				<ConfirmDialogRoot
					open={closingTab !== undefined}
					onOpenChange={(open) => {
						if (!open) setClosingTabId(null);
					}}
				>
					<ConfirmDialog
						title="Close this tab?"
						description={`It has ${closingTab ? terminalIds(closingTab.root).length : 0} terminals. Closing the tab ends them all.`}
						confirmLabel="Close tab"
						onConfirm={() => {
							if (closingTabId) closeTab(closingTabId);
						}}
						onCancel={() => setClosingTabId(null)}
					/>
				</ConfirmDialogRoot>
			</div>
			{/* The dragged pane stays put; only its title follows the pointer. */}
			<DragOverlay dropAnimation={null}>
				{draggedPane ? (
					<div className="pk-term-drag" data-testid="pane-drag-overlay">
						{draggedPane.title}
					</div>
				) : null}
			</DragOverlay>
		</DndContext>
	);
}
