/**
 * The frame around one file's pane: a title bar that is also the drag handle,
 * an actions menu with the click ways to move the pane, and the drop area
 * (SPEC.md §8.3, §9.3, §25.8). A file can share a split with terminals and
 * other files; what the pane shows is the caller's.
 */
import { useDraggable, useDroppable } from "@dnd-kit/core";
import {
	IconButton,
	Menu,
	MenuItem,
	MenuRoot,
	MenuSeparator,
	MenuSub,
	MenuTrigger,
} from "@portikus/ui";
import { type ReactNode, useEffect, useRef } from "react";
import { baseName, displayName } from "../files/paths.js";
import { type DropEdge, fileTabId } from "../layout/tree.js";
import { usePaneMenuFocus } from "./pointerDismiss.js";

export interface FilePaneProps {
	path: string;
	/** The only pane in its tab, which already has a tab of its own. */
	alone: boolean;
	/** True when this pane should take the keyboard as it mounts, as after a move. */
	focused: boolean;
	/** The zone to shade while a pane is being dragged over this one. */
	dropEdge: DropEdge | null;
	/** The other tabs this pane can join, named as the tab strip names them. */
	moveTargets: { tabId: string; label: string }[];
	/** Mark this pane as the one the keyboard is in, by its pane id. */
	onFocus: (paneId: string) => void;
	/** Give this pane a tab of its own, the keyboard way to drag it. */
	onMoveToNewTab: (paneId: string) => void;
	/** Put this pane into another tab's split, the click way to drag it there. */
	onMoveInto: (paneId: string, tabId: string) => void;
	/** Share this tab's space out evenly again. */
	onResetSizes: () => void;
	onClose: (path: string) => void;
	children: ReactNode;
}

export function FilePane({
	path,
	alone,
	focused,
	dropEdge,
	moveTargets,
	onFocus,
	onMoveToNewTab,
	onMoveInto,
	onResetSizes,
	onClose,
	children,
}: FilePaneProps) {
	const id = fileTabId(path);
	const name = displayName(baseName(path));
	const shownPath = displayName(path);
	const menu = usePaneMenuFocus();
	const actions = useRef<HTMLButtonElement | null>(null);
	const drag = useDraggable({
		id: `pane-drag-${id}`,
		data: { paneId: id, title: name },
	});
	const drop = useDroppable({ id: `pane-drop-${id}`, data: { paneId: id } });

	// A move mounts the pane again in its new place; the keyboard follows it
	// there rather than falling to the page. A remount while the keyboard is
	// somewhere else, such as the file tree, leaves it there.
	const focusedAtMount = useRef(focused);
	useEffect(() => {
		const dropped =
			document.activeElement === null || document.activeElement === document.body;
		if (focusedAtMount.current && dropped) actions.current?.focus();
	}, []);

	return (
		<section
			ref={drop.setNodeRef}
			className={`pk-filepane ${drag.isDragging ? "is-dragged" : ""}`}
			aria-label={`File: ${shownPath}`}
			data-testid={`file-frame-${path}`}
			onFocusCapture={() => onFocus(id)}
		>
			<div className="pk-filepane-bar">
				{/* Only the drag listeners: dnd-kit's attributes would add a focus stop. */}
				<span
					ref={drag.setNodeRef}
					className="pk-filepane-title"
					title={shownPath}
					data-testid={`file-frame-handle-${path}`}
					{...drag.listeners}
				>
					{name}
				</span>
				<MenuRoot onOpenChange={menu.onOpenChange}>
					<MenuTrigger asChild={true}>
						<IconButton
							ref={actions}
							icon="more"
							label={`Actions for ${name}`}
							size="sm"
							data-testid={`file-frame-actions-${path}`}
						/>
					</MenuTrigger>
					<Menu label={`Actions for ${name}`} onCloseAutoFocus={menu.onCloseAutoFocus}>
						<MenuItem disabled={alone} onSelect={() => onMoveToNewTab(id)}>
							<span data-testid="file-frame-move-to-new-tab">Move to new tab</span>
						</MenuItem>
						<MenuSub
							label="Move into"
							disabled={moveTargets.length === 0}
							testId="file-frame-move-into"
						>
							{moveTargets.map((target) => (
								<MenuItem
									key={target.tabId}
									testId={`file-frame-move-into-${target.tabId}`}
									onSelect={() => onMoveInto(id, target.tabId)}
								>
									{target.label}
								</MenuItem>
							))}
						</MenuSub>
						<MenuItem disabled={alone} onSelect={onResetSizes}>
							<span data-testid="file-frame-reset-sizes">Reset pane sizes</span>
						</MenuItem>
						<MenuSeparator />
						{/* After the menu closes, so the caller can move the keyboard off
						    this pane instead of the menu returning it here. */}
						<MenuItem
							danger={true}
							onSelect={() => menu.thenFocus(() => onClose(path))}
						>
							<span data-testid="file-frame-close">Close</span>
						</MenuItem>
					</Menu>
				</MenuRoot>
			</div>
			{children}
			{dropEdge ? (
				<div
					className={`pk-term-drop pk-term-drop--${dropEdge}`}
					data-testid={`drop-zone-${id}`}
					data-edge={dropEdge}
				/>
			) : null}
		</section>
	);
}
