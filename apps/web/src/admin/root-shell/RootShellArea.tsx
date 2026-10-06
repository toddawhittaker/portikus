/**
 * The Root shell tab: root shells on the server in tabs and split panes,
 * laid out as the workspace terminals are (ADR 0051; SPEC.md §9.3). The
 * layout lives only in this page, since a reload ends every shell.
 */
import { DndContext, DragOverlay, pointerWithin, useDroppable } from "@dnd-kit/core";
import { EDITOR_SETTINGS_DEFAULTS } from "@portikus/contracts";
import {
	Button,
	ConfirmDialog,
	ConfirmDialogRoot,
	EmptyState,
	IconButton,
	type TabItem,
	Tabs,
	tabDomId,
	tabPanelDomId,
} from "@portikus/ui";
import { type ReactNode, useId, useRef, useState } from "react";
import { useEditorSettings } from "../../editor/settingsQueries.js";
import { SplitTree } from "../../layout/SplitTree.js";
import { createLayoutStore, useLayout } from "../../layout/store.js";
import { type SplitDirection, terminalIds } from "../../layout/tree.js";
import { moveIntoTargets } from "../../work/moveInto.js";
import { TAB_STRIP_DROP_ID, usePaneDrag } from "../../work/usePaneDrag.js";
import "../../work/work.css";
import "./root-shell.css";
import { RootShellBanner } from "./RootShellBanner.js";
import { RootShellLeaf } from "./RootShellLeaf.js";
import { createSessionHost, RootShellSession } from "./RootShellSession.js";

/** The tab strip as a drop area; separate so it can use `useDroppable`. */
function TabStripDrop({ children }: { children: ReactNode }) {
	const drop = useDroppable({ id: TAB_STRIP_DROP_ID });
	return (
		<div className="pk-work-tabs-drop" ref={drop.setNodeRef}>
			{children}
		</div>
	);
}

export interface RootShellAreaProps {
	/** False while another admin tab is shown; the shells keep running. */
	visible: boolean;
}

export function RootShellArea({ visible }: RootShellAreaProps) {
	const headingId = useId();
	const [store] = useState(createLayoutStore);
	const layout = useLayout(store, (state) => state.layout);
	const activeTabId = useLayout(store, (state) => state.activeTabId);
	const focusedId = useLayout(store, (state) => state.focusedTerminalId);
	// Each shell's name, by id. Numbers count up for this page and are not reused.
	const [names, setNames] = useState<Map<string, string>>(() => new Map());
	const opened = useRef(0);
	const [closingTabId, setClosingTabId] = useState<string | null>(null);
	const strip = useRef<HTMLDivElement | null>(null);
	const settings = useEditorSettings();
	const theme = settings.data?.terminalTheme ?? EDITOR_SETTINGS_DEFAULTS.terminalTheme;
	const screenReaderMode =
		settings.data?.screenReaderMode ?? EDITOR_SETTINGS_DEFAULTS.screenReaderMode;
	const drag = usePaneDrag({
		tabs: layout.tabs,
		strip,
		moveLeaf: (tabId, dragged, target, edge) =>
			store.getState().moveLeaf(tabId, dragged, target, edge),
		moveLeafToNewTab: (dragged, index) =>
			store.getState().moveLeafToNewTab(dragged, index),
	});

	// Each session's element, which its pane adopts (RootShellSession).
	const hosts = useRef(new Map<string, HTMLDivElement>());
	function hostFor(shellId: string): HTMLDivElement {
		let host = hosts.current.get(shellId);
		if (!host) {
			host = createSessionHost();
			hosts.current.set(shellId, host);
		}
		return host;
	}
	// Shells gone without exiting, whose panes stay until closed.
	const [ended, setEndedSet] = useState<ReadonlySet<string>>(() => new Set());
	function setEnded(shellId: string, gone: boolean) {
		setEndedSet((current) => {
			const next = new Set(current);
			if (gone) next.add(shellId);
			else next.delete(shellId);
			return next;
		});
	}
	const tabOf = new Map(
		layout.tabs.flatMap((tab) =>
			terminalIds(tab.root).map((id) => [id, tab.id] as const),
		),
	);

	/** A new shell's id, with its name recorded. */
	function newShell(): string {
		const id = crypto.randomUUID();
		opened.current += 1;
		const name = `Root shell ${opened.current}`;
		setNames((current) => new Map(current).set(id, name));
		return id;
	}

	function openShellTab() {
		const id = newShell();
		store.getState().addTab(id);
		store.getState().setFocused(id);
	}

	function split(shellId: string, direction: SplitDirection) {
		const id = newShell();
		store.getState().splitLeaf(shellId, direction, id);
		store.getState().setFocused(id);
	}

	/** Dropping the session closes its socket, which hangs up the shell. */
	function closeShell(shellId: string) {
		store.getState().removeLeaf(shellId);
		setNames((current) => {
			const next = new Map(current);
			next.delete(shellId);
			return next;
		});
		setEnded(shellId, false);
		hosts.current.delete(shellId);
	}

	/** A shell that exited takes its pane away; the keyboard goes to New root shell. */
	function shellExited(shellId: string) {
		const pane = document.querySelector(`[data-testid="terminal-pane-${shellId}"]`);
		if (pane?.contains(document.activeElement)) {
			strip.current
				?.querySelector<HTMLElement>('[data-testid="root-shell-new"]')
				?.focus();
		}
		closeShell(shellId);
	}

	function closeTab(tabId: string) {
		const tab = layout.tabs.find((item) => item.id === tabId);
		if (tab) for (const id of terminalIds(tab.root)) closeShell(id);
		setClosingTabId(null);
	}

	function requestCloseTab(tabId: string) {
		const tab = layout.tabs.find((item) => item.id === tabId);
		if (tab && terminalIds(tab.root).length > 1) {
			setClosingTabId(tabId);
			return;
		}
		closeTab(tabId);
	}

	/** Alt+Shift+Q leaves the terminal for the tab strip, as in a workspace. */
	function leaveTerminal() {
		const tabs = strip.current?.querySelectorAll<HTMLElement>('[role="tab"]');
		if (!tabs) return;
		const index = layout.tabs.findIndex((tab) => tab.id === activeTabId);
		(tabs[index < 0 ? 0 : index] ?? tabs[0])?.focus();
	}

	function moveToNewTab(shellId: string) {
		const from = layout.tabs.findIndex((tab) =>
			terminalIds(tab.root).includes(shellId),
		);
		store.getState().moveLeafToNewTab(shellId, from + 1);
		store.getState().setFocused(shellId);
	}

	const items: TabItem[] = layout.tabs.map((tab) => {
		const first = terminalIds(tab.root)[0];
		return {
			id: tab.id,
			kind: "terminal",
			label: (first && names.get(first)) ?? "Root shell",
			testId: `tab-${tab.id}`,
		};
	});

	function moveTargetsFor(shellId: string) {
		return moveIntoTargets(layout, shellId).map((target) => ({
			tabId: target.tabId,
			label: items.find((item) => item.id === target.tabId)?.label ?? "Tab",
		}));
	}

	function moveInto(shellId: string, tabId: string) {
		const target = moveIntoTargets(layout, shellId).find(
			(candidate) => candidate.tabId === tabId,
		);
		if (!target) return;
		store.getState().moveLeaf(tabId, shellId, target.terminalId, target.edge);
		store.getState().setFocused(shellId);
	}

	const closingTab = layout.tabs.find((tab) => tab.id === closingTabId);

	return (
		<section
			className="pk-rootshell"
			aria-labelledby={headingId}
			hidden={!visible}
			data-testid="root-shell-area"
		>
			<div className="pk-rootshell-head">
				<h2
					className="pk-text-heading m-0"
					id={headingId}
					tabIndex={-1}
					data-admin-heading
				>
					Root shell
				</h2>
				<RootShellBanner />
			</div>
			<DndContext
				sensors={drag.sensors}
				collisionDetection={pointerWithin}
				{...drag.handlers}
			>
				<div className="pk-work-area">
					<TabStripDrop>
						<div className="pk-work-tabs" data-testid="root-shell-tabs" ref={strip}>
							<Tabs
								tabs={items}
								activeId={activeTabId ?? ""}
								label="Open root shells"
								onSelect={(id) => store.getState().setActive(id)}
								onClose={requestCloseTab}
								onReorder={(from, to) => store.getState().moveTab(from, to)}
								actions={
									<IconButton
										icon="plus"
										label="New root shell"
										size="sm"
										data-testid="root-shell-new"
										onClick={openShellTab}
									/>
								}
							/>
							{drag.dragTarget?.kind === "strip" ? (
								<div
									className="pk-tab-insert"
									data-testid="tab-insert-marker"
									style={{ left: `${drag.dragTarget.markerX}px` }}
								/>
							) : null}
						</div>
					</TabStripDrop>

					{layout.tabs.length === 0 ? (
						<EmptyState
							icon="terminal"
							title="No root shells open"
							actions={
								<Button
									variant="primary"
									iconStart="terminal"
									data-testid="root-shell-open"
									onClick={openShellTab}
								>
									Open a root shell
								</Button>
							}
						>
							A root shell signs in as root on this server, as SSH would. Split it or
							open more from the + in the tab bar.
						</EmptyState>
					) : (
						layout.tabs.map((tab) => (
							<div
								key={tab.id}
								role="tabpanel"
								id={tabPanelDomId(tab.id)}
								aria-labelledby={tabDomId(tab.id)}
								className="pk-termgroup"
								hidden={tab.id !== activeTabId}
							>
								<SplitTree
									tabId={tab.id}
									root={tab.root}
									onResize={(path, sizes) =>
										store.getState().resize(tab.id, path, sizes)
									}
									renderLeaf={(node, { resetSizes }) => {
										if (node.type !== "leaf") return null;
										const id = node.terminalId;
										const drop = drag.dropTargetIn(tab.id);
										return (
											<RootShellLeaf
												key={id}
												shellId={id}
												name={names.get(id) ?? "Root shell"}
												theme={theme}
												host={hostFor(id)}
												ended={ended.has(id)}
												focused={focusedId === id}
												alone={tab.root.type === "leaf"}
												dropEdge={drop?.terminalId === id ? drop.edge : null}
												moveTargets={moveTargetsFor(id)}
												onFocus={(shellId) => store.getState().setFocused(shellId)}
												onSplit={split}
												onMoveToNewTab={moveToNewTab}
												onMoveInto={moveInto}
												onResetSizes={resetSizes}
												onLeave={leaveTerminal}
												onClose={closeShell}
											/>
										);
									}}
								/>
							</div>
						))
					)}
				</div>
				{/* Here, where a pane moving between tabs does not remount them. */}
				{[...names].map(([id, name]) => (
					<RootShellSession
						key={id}
						shellId={id}
						host={hostFor(id)}
						name={name}
						theme={theme}
						screenReaderMode={screenReaderMode}
						visible={visible && tabOf.get(id) === activeTabId}
						focused={focusedId === id}
						onFocus={(shellId) => store.getState().setFocused(shellId)}
						onLeave={leaveTerminal}
						onExited={shellExited}
						onEndedChange={setEnded}
					/>
				))}
				{/* The dragged pane stays put; only its title follows the pointer. */}
				<DragOverlay dropAnimation={null}>
					{drag.draggedPane ? (
						<div className="pk-term-drag" data-testid="pane-drag-overlay">
							{drag.draggedPane.title}
						</div>
					) : null}
				</DragOverlay>
			</DndContext>

			<ConfirmDialogRoot
				open={closingTab !== undefined}
				onOpenChange={(open) => {
					if (!open) setClosingTabId(null);
				}}
			>
				<ConfirmDialog
					title="Close this tab?"
					description={`It has ${closingTab ? terminalIds(closingTab.root).length : 0} root shells. Closing the tab ends them all.`}
					confirmLabel="Close tab"
					onConfirm={() => {
						if (closingTabId) closeTab(closingTabId);
					}}
					onCancel={() => setClosingTabId(null)}
				/>
			</ConfirmDialogRoot>
		</section>
	);
}
