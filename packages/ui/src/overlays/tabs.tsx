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
import { Icon, IconButton, type IconName } from "./_stubs";

export interface TabItem {
	id: string;
	kind: "terminal" | "claude" | "codex" | "file" | "preview" | "panel";
	label: string;
	title?: string;
	dirty?: boolean;
	ended?: boolean;
	closable?: boolean;
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
	launcherOpen?: boolean;
	/** Preview only: render a tab as if it were being dragged. */
	draggingId?: string;
	/** Preview only: render the drop line before a tab. */
	dropBeforeId?: string;
	className?: string;
}

const KIND_ICON: Record<TabItem["kind"], IconName> = {
	terminal: "terminal",
	claude: "agent",
	codex: "agent",
	file: "file",
	preview: "preview",
	panel: "info",
};

interface TabTriggerProps {
	tab: TabItem;
	dragging: boolean;
	dropBefore: boolean;
	onClose?: (id: string) => void;
	onMove: (tab: TabItem, direction: -1 | 1) => void;
}

function TabTrigger({
	tab,
	dragging,
	dropBefore,
	onClose,
	onMove,
}: TabTriggerProps): React.ReactElement {
	const sortable = useSortable({ id: tab.id });
	const closable = tab.closable !== false;
	return (
		<RadixTabs.Trigger
			ref={sortable.setNodeRef}
			value={tab.id}
			title={tab.title ?? tab.label}
			className={[
				"pk-tab",
				tab.kind === "terminal" && !tab.ended ? "pk-tab--terminal" : "",
				tab.ended ? "pk-tab--ended" : "",
				dragging || sortable.isDragging ? "pk-tab--dragging" : "",
				dropBefore ? "pk-tab--drop-before" : "",
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
				if (event.key === "Delete" && closable) {
					event.preventDefault();
					onClose?.(tab.id);
				}
			}}
		>
			<Icon name={KIND_ICON[tab.kind]} size="sm" />
			<span className="pk-tab-label">
				{tab.label}
				{tab.ended ? <span className="pk-visually-hidden">, session ended</span> : null}
			</span>
			{closable ? (
				tab.dirty ? (
					<span className="pk-tab-close" role="img" aria-label="Unsaved changes">
						<span className="pk-tab-dirty" />
					</span>
				) : (
					// The tab itself is a button, so this cannot be one: nested
					// buttons are invalid HTML.
					// biome-ignore lint/a11y/useSemanticElements: nested button
					<span
						className="pk-tab-close pk-tab-close--hover"
						role="button"
						tabIndex={-1}
						aria-label={`Close ${tab.label}`}
						onClick={(event) => {
							event.stopPropagation();
							onClose?.(tab.id);
						}}
						onKeyDown={(event) => {
							if (event.key === "Enter" || event.key === " ") {
								event.stopPropagation();
								onClose?.(tab.id);
							}
						}}
					>
						<Icon name="x" size="sm" />
					</span>
				)
			) : null}
		</RadixTabs.Trigger>
	);
}

/** The work-area tab strip: Radix Tabs with dnd-kit reordering. */
export function Tabs({
	tabs,
	activeId,
	label,
	onSelect,
	onClose,
	onReorder,
	actions,
	launcherOpen,
	draggingId,
	dropBeforeId,
	className,
}: TabsProps): React.ReactElement {
	const [announcement, setAnnouncement] = React.useState("");
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
					<RadixTabs.List aria-label={label ?? "Open tabs"} className="pk-tablist flex">
						{tabs.map((tab) => (
							<TabTrigger
								key={tab.id}
								tab={tab}
								dragging={tab.id === draggingId}
								dropBefore={tab.id === dropBeforeId}
								onClose={onClose}
								onMove={move}
							/>
						))}
					</RadixTabs.List>
				</SortableContext>
			</DndContext>
			<div className="pk-tabs-actions flex items-center gap-0.5 px-1">
				{actions ?? (
					<IconButton
						icon="plus"
						label="New tab"
						size="sm"
						aria-haspopup="menu"
						aria-expanded={launcherOpen ?? false}
					/>
				)}
			</div>
			<span className="pk-visually-hidden" aria-live="polite">
				{announcement}
			</span>
		</RadixTabs.Root>
	);
}
