import {
	closestCenter,
	DndContext,
	type DragEndEvent,
	KeyboardSensor,
	PointerSensor,
	useSensor,
	useSensors,
} from "@dnd-kit/core";
import {
	horizontalListSortingStrategy,
	SortableContext,
	sortableKeyboardCoordinates,
	useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import * as RadixTabs from "@radix-ui/react-tabs";
import * as React from "react";
import { Icon, IconButton, type IconName } from "../primitives/index.js";
import {
	ContextMenu,
	ContextMenuTrigger,
	Menu,
	MenuItem,
	MenuSeparator,
} from "./menu.js";

export interface TabItem {
	id: string;
	kind: "terminal" | "claude" | "codex" | "file" | "diff" | "preview" | "panel";
	label: string;
	/** Hover text, when the label is a shortened form of something longer. */
	title?: string;
	ended?: boolean;
	/** Unsaved changes: the dot takes the close button's place. */
	dirty?: boolean;
	/** Test hook: set as `data-testid` on the trigger, plus `-close` on the close control. */
	testId?: string;
}

export interface TabsProps {
	tabs: TabItem[];
	activeId: string;
	label?: string;
	onSelect?: (id: string) => void;
	onClose?: (id: string) => void;
	onReorder?: (from: number, to: number) => void;
	/** The launcher (IconButton + Menu). Defaults to a "New tab" IconButton. */
	actions?: React.ReactNode;
	className?: string;
}

/**
 * DOM ids for a tab and the panel it controls. Radix lets these override its
 * generated ids, so a panel rendered elsewhere can name itself by its tab.
 * Encoded because ids and aria-labelledby cannot hold whitespace.
 */
export function tabDomId(id: string): string {
	return `pk-tab-${encodeURIComponent(id)}`;
}

export function tabPanelDomId(id: string): string {
	return `pk-tabpanel-${encodeURIComponent(id)}`;
}

const KIND_ICON: Record<TabItem["kind"], IconName> = {
	terminal: "terminal",
	claude: "agent",
	codex: "agent",
	file: "file",
	diff: "file",
	preview: "preview",
	panel: "info",
};

interface TabTriggerProps {
	tab: TabItem;
	/** Id of the hidden text that explains the keyboard shortcuts. */
	hintId: string;
	onClose?: (id: string) => void;
	onMove: (tab: TabItem, direction: -1 | 1) => void;
}

function TabTrigger({
	tab,
	hintId,
	onClose,
	onMove,
}: TabTriggerProps): React.ReactElement {
	const sortable = useSortable({ id: tab.id });
	return (
		<RadixTabs.Trigger
			ref={sortable.setNodeRef}
			value={tab.id}
			id={tabDomId(tab.id)}
			aria-controls={tabPanelDomId(tab.id)}
			title={tab.title ?? tab.label}
			data-testid={tab.testId}
			// The close control sits inside the tab, so assistive technology only
			// learns about closing and moving from these.
			aria-keyshortcuts="Delete Alt+Shift+ArrowLeft Alt+Shift+ArrowRight"
			aria-describedby={hintId}
			className={[
				"pk-tab",
				tab.kind === "terminal" && !tab.ended ? "pk-tab--terminal" : "",
				tab.ended ? "pk-tab--ended" : "",
				sortable.isDragging ? "pk-tab--dragging" : "",
			]
				.filter(Boolean)
				.join(" ")}
			style={{
				transform: CSS.Transform.toString(sortable.transform),
				transition: sortable.transition,
			}}
			// Only the drag listeners: dnd-kit's own attributes would replace the
			// tab role, and its keyboard listener would swallow Enter.
			{...sortable.listeners}
			onKeyDown={(event) => {
				if (
					event.altKey &&
					event.shiftKey &&
					(event.key === "ArrowLeft" || event.key === "ArrowRight")
				) {
					event.preventDefault();
					onMove(tab, event.key === "ArrowLeft" ? -1 : 1);
					return;
				}
				if (event.key === "Delete") {
					event.preventDefault();
					onClose?.(tab.id);
				}
			}}
		>
			<Icon name={KIND_ICON[tab.kind]} size="sm" />
			<span className="pk-tab-label">
				{tab.label}
				{tab.ended ? <span className="pk-visually-hidden">(session ended)</span> : null}
			</span>
			{/* An unsaved tab shows a dot where the close button goes; CSS swaps
			    the two back on hover or focus, as Chrome and VS Code do. */}
			{tab.dirty ? (
				<span
					className="pk-tab-dirty"
					data-testid={tab.testId ? `${tab.testId}-dirty` : undefined}
				>
					<span className="pk-visually-hidden">Unsaved changes</span>
				</span>
			) : null}
			{/* Pointer only: nested buttons are invalid HTML, and the keyboard
			    closes a tab with Delete (aria-keyshortcuts on the tab). */}
			<span
				className="pk-tab-close"
				aria-hidden="true"
				data-testid={tab.testId ? `${tab.testId}-close` : undefined}
				onClick={(event) => {
					event.stopPropagation();
					onClose?.(tab.id);
				}}
			>
				<Icon name="x" size="sm" />
			</span>
		</RadixTabs.Trigger>
	);
}

// Plain Radix tabs for panes that need no reordering or close buttons.
export const TabsRoot = RadixTabs.Root;
export const TabsList = RadixTabs.List;
export const TabsTrigger = RadixTabs.Trigger;
export const TabsContent = RadixTabs.Content;

/** The work-area tab strip: Radix Tabs with dnd-kit reordering. */
export function Tabs({
	tabs,
	activeId,
	label,
	onSelect,
	onClose,
	onReorder,
	actions,
	className,
}: TabsProps): React.ReactElement {
	const [announcement, setAnnouncement] = React.useState("");
	const list = React.useRef<HTMLDivElement | null>(null);
	const hintId = React.useId();
	// The tab whose right-click menu is open: one menu serves the whole strip.
	const [menuTabId, setMenuTabId] = React.useState<string | null>(null);

	// Selecting a tab brings it back into view, however the selection was made
	// (click, keyboard, Ctrl+Tab, or opening a file).
	const activeIndex = tabs.findIndex((tab) => tab.id === activeId);
	React.useEffect(() => {
		const container = list.current;
		if (!container || activeIndex < 0) return;
		const rendered = container.querySelectorAll<HTMLElement>('[role="tab"]');
		rendered[activeIndex]?.scrollIntoView({ block: "nearest", inline: "nearest" });
	}, [activeIndex]);

	/** The wheel scrolls the strip sideways, because it has no vertical axis. */
	function onWheel(event: React.WheelEvent<HTMLDivElement>) {
		const container = list.current;
		if (!container || event.deltaY === 0 || event.deltaX !== 0) return;
		container.scrollLeft += event.deltaY;
	}

	const sensors = useSensors(
		// 4px so a click still selects the tab instead of starting a drag.
		useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
		useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
	);
	const ids = tabs.map((tab) => tab.id);

	function move(tab: TabItem, direction: -1 | 1) {
		const from = ids.indexOf(tab.id);
		const to = from + direction;
		if (from < 0 || to < 0 || to >= tabs.length) return;
		onReorder?.(from, to);
		setAnnouncement(`${tab.label} moved to position ${to + 1} of ${tabs.length}`);
	}

	/** Which tab a right-click or Shift+F10 landed on, if any. */
	function tabAt(target: EventTarget): TabItem | undefined {
		const trigger = target instanceof Element ? target.closest('[role="tab"]') : null;
		const rendered = [...(list.current?.querySelectorAll('[role="tab"]') ?? [])];
		return trigger ? tabs[rendered.indexOf(trigger)] : undefined;
	}

	// The tab just asked to close. Once it is gone, focus goes to the selected
	// tab rather than dropping to the page (WAI-ARIA tabs pattern, SPEC.md §25.8).
	const closing = React.useRef<string | null>(null);
	function close(id: string) {
		closing.current = id;
		onClose?.(id);
	}
	React.useEffect(() => {
		const id = closing.current;
		if (id === null || tabs.some((tab) => tab.id === id)) return;
		closing.current = null;
		const focused = document.activeElement;
		// Something else took focus, such as a dialog: leave it there.
		if (focused && focused !== document.body && !list.current?.contains(focused))
			return;
		document.getElementById(tabDomId(activeId))?.focus();
	}, [tabs, activeId]);

	const menuIndex = menuTabId === null ? -1 : ids.indexOf(menuTabId);
	const menuTab = tabs[menuIndex];

	function handleDragEnd(event: DragEndEvent) {
		const { active, over } = event;
		if (!over || active.id === over.id) return;
		const from = ids.indexOf(String(active.id));
		const to = ids.indexOf(String(over.id));
		if (from < 0 || to < 0) return;
		onReorder?.(from, to);
	}

	return (
		<RadixTabs.Root
			value={activeId}
			// Manual so arrow keys only move focus; Enter or Space activates.
			activationMode="manual"
			onValueChange={(value) => onSelect?.(value)}
			className={`pk-tabs ${className ?? ""}`}
		>
			<DndContext
				sensors={sensors}
				collisionDetection={closestCenter}
				onDragEnd={handleDragEnd}
			>
				<SortableContext items={ids} strategy={horizontalListSortingStrategy}>
					{/* The menu is the pointer way to move a tab without dragging
					    it (WCAG 2.5.7, SPEC.md §25.8). */}
					<ContextMenu>
						<ContextMenuTrigger
							asChild={true}
							onContextMenu={(event) => {
								const tab = tabAt(event.target);
								// Off the tabs there is nothing to act on, so no menu.
								if (!tab) {
									event.preventDefault();
									return;
								}
								setMenuTabId(tab.id);
							}}
						>
							<RadixTabs.List
								ref={list}
								aria-label={label ?? "Open tabs"}
								className="pk-tablist"
								onWheel={onWheel}
							>
								{tabs.map((tab) => (
									<TabTrigger
										key={tab.id}
										tab={tab}
										hintId={hintId}
										onClose={close}
										onMove={move}
									/>
								))}
							</RadixTabs.List>
						</ContextMenuTrigger>
						{menuTab ? (
							<Menu label={`Actions for ${menuTab.label}`}>
								<MenuItem
									disabled={menuIndex === 0}
									onSelect={() => move(menuTab, -1)}
									testId="tab-move-left"
								>
									Move left
								</MenuItem>
								<MenuItem
									disabled={menuIndex === tabs.length - 1}
									onSelect={() => move(menuTab, 1)}
									testId="tab-move-right"
								>
									Move right
								</MenuItem>
								<MenuSeparator />
								<MenuItem onSelect={() => close(menuTab.id)} testId="tab-menu-close">
									Close tab
								</MenuItem>
							</Menu>
						) : null}
					</ContextMenu>
				</SortableContext>
			</DndContext>
			<div className="pk-tabs-actions flex items-center gap-0.5 px-1">
				{actions ?? (
					<IconButton icon="plus" label="New tab" size="sm" aria-haspopup="menu" />
				)}
			</div>
			<span id={hintId} className="pk-visually-hidden">
				Delete closes the tab. Alt+Shift+Left or Right Arrow moves it. Shift+F10 opens
				its menu.
			</span>
			<span className="pk-visually-hidden" aria-live="polite">
				{announcement}
			</span>
		</RadixTabs.Root>
	);
}
