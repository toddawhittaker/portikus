/**
 * One terminal pane inside a split: the title bar with its actions and the
 * terminal itself (SPEC.md §9.3). A terminal ended by a workspace stop keeps
 * its place and offers a new one (SPEC.md §6.8).
 */
import { useDraggable, useDroppable } from "@dnd-kit/core";
import type { Terminal, TerminalTheme } from "@portikus/contracts";
import {
	Button,
	IconButton,
	Menu,
	MenuItem,
	MenuRoot,
	MenuSeparator,
	MenuTrigger,
} from "@portikus/ui";
import { useEffect, useRef, useState } from "react";
import type { DropEdge, SplitDirection } from "../layout/tree.js";
import { TerminalPane } from "../TerminalPane.js";

/** The dnd-kit ids for one pane's drag handle and its drop area. */
export function paneDragId(terminalId: string): string {
	return `pane-drag-${terminalId}`;
}

export function paneDropId(terminalId: string): string {
	return `pane-drop-${terminalId}`;
}

export interface TerminalLeafProps {
	workspaceId: string;
	projectId: string;
	terminal: Terminal;
	visible: boolean;
	focused: boolean;
	onFocus: (terminalId: string) => void;
	onSplit: (terminalId: string, direction: SplitDirection) => void;
	onRename: (terminalId: string, name: string) => void;
	/** Switch this one terminal between the light and dark scheme (issue #268). */
	onSetTheme: (terminalId: string, theme: TerminalTheme) => void;
	onClose: (terminalId: string) => void;
	onExited: (terminalId: string) => void;
	onReplace: (terminalId: string) => void;
	onSessionEnded: () => void;
	onLeave: () => void;
	/** Give this pane a tab of its own, the keyboard way to drag it (issue #370). */
	onMoveToNewTab: (terminalId: string) => void;
	/** The only pane in its tab, which already has a tab of its own. */
	alone: boolean;
	/** The zone to shade while a pane is being dragged over this one. */
	dropEdge?: DropEdge | null;
}

/**
 * Radix focuses a menu trigger when the menu closes, and that programmatic
 * focus paints the focus ring. A pointer dismiss leaves the trigger at rest;
 * a keyboard dismiss still focuses it.
 */
function usePointerDismissFocus() {
	const pointer = useRef(false);
	const stop = useRef<(() => void) | null>(null);

	useEffect(() => () => stop.current?.(), []);

	function onOpenChange(next: boolean) {
		stop.current?.();
		stop.current = null;
		if (!next) return;
		pointer.current = false;
		const onPointerDown = () => {
			pointer.current = true;
		};
		const onKeyDown = (event: globalThis.KeyboardEvent) => {
			if (event.key === "Escape" || event.key === "Enter" || event.key === " ") {
				pointer.current = false;
			}
		};
		document.addEventListener("pointerdown", onPointerDown, true);
		document.addEventListener("keydown", onKeyDown, true);
		stop.current = () => {
			document.removeEventListener("pointerdown", onPointerDown, true);
			document.removeEventListener("keydown", onKeyDown, true);
		};
	}

	// An action that moves the keyboard elsewhere runs once the menu has
	// closed, instead of the trigger taking the keyboard back.
	const afterClose = useRef<(() => void) | null>(null);
	function thenFocus(action: () => void) {
		afterClose.current = action;
	}

	function onCloseAutoFocus(event: Event) {
		const action = afterClose.current;
		if (action) {
			afterClose.current = null;
			event.preventDefault();
			action();
			return;
		}
		if (!pointer.current) return;
		event.preventDefault();
		pointer.current = false;
	}

	return { onOpenChange, onCloseAutoFocus, thenFocus };
}

/** `/home/student/projects/x` reads as `~/projects/x` to a student. */
export function shortenPath(path: string): string {
	return path.startsWith("/home/student")
		? `~${path.slice("/home/student".length)}`
		: path;
}

export function TerminalLeaf({
	workspaceId,
	projectId,
	terminal,
	visible,
	focused,
	onFocus,
	onSplit,
	onRename,
	onSetTheme,
	onClose,
	onExited,
	onReplace,
	onSessionEnded,
	onLeave,
	onMoveToNewTab,
	alone,
	dropEdge = null,
}: TerminalLeafProps) {
	const [renaming, setRenaming] = useState(false);
	const [draft, setDraft] = useState(terminal.name);
	const field = useRef<HTMLInputElement | null>(null);
	const mountId = useRef(crypto.randomUUID());
	const actionsMenu = usePointerDismissFocus();
	// The menu returns focus to its trigger as it closes, so the field waits
	// for that to happen and only commits on a blur once it really had focus.
	const armed = useRef(false);
	// The agent reports the directory as the student cds around (SPEC.md §9.3).
	const [liveCwd, setLiveCwd] = useState(terminal.cwd);
	const ended = terminal.endedAt !== null;
	const title = `${terminal.name} · ${shortenPath(liveCwd)}`;
	// The title bar is the drag handle; the whole pane is a drop area
	// (SPEC.md §9.3).
	const drag = useDraggable({
		id: paneDragId(terminal.id),
		data: { terminalId: terminal.id, title },
	});
	const drop = useDroppable({
		id: paneDropId(terminal.id),
		data: { terminalId: terminal.id },
	});

	useEffect(() => {
		if (!renaming) {
			armed.current = false;
			return;
		}
		const timer = setTimeout(() => {
			field.current?.focus();
			field.current?.select();
		}, 50);
		return () => clearTimeout(timer);
	}, [renaming]);

	function commitRename() {
		const name = draft.trim();
		if (name.length > 0 && name !== terminal.name) onRename(terminal.id, name);
		setRenaming(false);
	}

	return (
		<section
			ref={drop.setNodeRef}
			className={`pk-term ${focused ? "is-focused" : ""} ${drag.isDragging ? "is-dragged" : ""}`}
			aria-label={`Terminal: ${title}`}
			data-testid={`terminal-leaf-${terminal.id}`}
			// The pane's own --terminal-* tokens, so the title bar and the
			// scrollbar follow this terminal rather than the per-user default
			// on the document (issue #286).
			data-terminal-theme={terminal.theme}
			// Changes only when this pane is mounted again, which a test reads
			// to tell a move apart from a teardown and reconnect.
			data-mount-id={mountId.current}
			onFocusCapture={() => onFocus(terminal.id)}
			onMouseDown={() => onFocus(terminal.id)}
		>
			<div className="pk-term-bar">
				{renaming ? (
					<input
						ref={field}
						aria-label={`Rename ${terminal.name}`}
						data-testid="terminal-rename-field"
						className="pk-term-bar-input"
						value={draft}
						onFocus={() => {
							armed.current = true;
						}}
						onChange={(event) => setDraft(event.target.value)}
						onBlur={() => {
							if (armed.current) commitRename();
						}}
						onKeyDown={(event) => {
							if (event.key === "Enter") commitRename();
							if (event.key === "Escape") setRenaming(false);
						}}
					/>
				) : (
					// Only the drag listeners: dnd-kit's attributes would make the
					// title a focus stop inside the terminal.
					<span
						ref={drag.setNodeRef}
						className="pk-term-bar-title pk-term-bar-title--handle"
						data-testid={`terminal-handle-${terminal.id}`}
						{...drag.listeners}
					>
						{title}
					</span>
				)}
				<MenuRoot onOpenChange={actionsMenu.onOpenChange}>
					<MenuTrigger asChild={true}>
						<IconButton
							icon="more"
							label={`Actions for ${terminal.name}`}
							size="sm"
							data-testid={`terminal-actions-${terminal.id}`}
						/>
					</MenuTrigger>
					<Menu
						label={`Actions for ${terminal.name}`}
						onCloseAutoFocus={actionsMenu.onCloseAutoFocus}
					>
						<MenuItem disabled={ended} onSelect={() => onSplit(terminal.id, "row")}>
							<span data-testid="split-right">Split right</span>
						</MenuItem>
						<MenuItem disabled={ended} onSelect={() => onSplit(terminal.id, "column")}>
							<span data-testid="split-down">Split down</span>
						</MenuItem>
						<MenuItem disabled={alone} onSelect={() => onMoveToNewTab(terminal.id)}>
							<span data-testid="terminal-move-to-new-tab">Move to new tab</span>
						</MenuItem>
						<MenuSeparator />
						<MenuItem
							onSelect={() => {
								setDraft(terminal.name);
								setRenaming(true);
							}}
						>
							<span data-testid="terminal-rename">Rename</span>
						</MenuItem>
						<MenuItem
							onSelect={() =>
								onSetTheme(terminal.id, terminal.theme === "light" ? "dark" : "light")
							}
						>
							<span
								data-testid="terminal-theme-toggle"
								title="The colours change straight away. A program already running keeps the light or dark hint it started with, so restart it or use its own theme command."
							>
								{terminal.theme === "light" ? "Dark terminal" : "Light terminal"}
							</span>
						</MenuItem>
						<MenuSeparator />
						<MenuItem
							shortcut={["Alt", "Shift", "Q"]}
							onSelect={() => actionsMenu.thenFocus(onLeave)}
						>
							<span data-testid="terminal-leave">Leave terminal</span>
						</MenuItem>
						<MenuSeparator />
						<MenuItem danger={true} onSelect={() => onClose(terminal.id)}>
							<span data-testid="terminal-close">Close</span>
						</MenuItem>
					</Menu>
				</MenuRoot>
			</div>
			{ended ? (
				<div className="pk-term-ended" data-testid={`terminal-ended-${terminal.id}`}>
					<p className="pk-term-ended-text">
						This terminal ended when the workspace stopped
					</p>
					<Button
						variant="secondary"
						size="sm"
						data-testid="new-terminal-here"
						onClick={() => onReplace(terminal.id)}
					>
						New terminal here
					</Button>
				</div>
			) : (
				<TerminalPane
					workspaceId={workspaceId}
					projectId={projectId}
					terminal={terminal}
					visible={visible}
					focusOnMount={focused}
					onExited={onExited}
					onSessionEnded={onSessionEnded}
					onCwd={setLiveCwd}
					onFocus={onFocus}
					onLeave={onLeave}
				/>
			)}
			{dropEdge ? (
				<div
					className={`pk-term-drop pk-term-drop--${dropEdge}`}
					data-testid={`drop-zone-${terminal.id}`}
					data-edge={dropEdge}
				/>
			) : null}
		</section>
	);
}
