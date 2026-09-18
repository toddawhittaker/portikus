/**
 * One terminal pane inside a split: the title bar with its actions and the
 * terminal itself (SPEC.md §9.3). A terminal ended by a workspace stop keeps
 * its place and offers a new one (SPEC.md §6.8).
 */
import { useDraggable, useDroppable } from "@dnd-kit/core";
import type { Terminal } from "@portikus/contracts";
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
	onClose: (terminalId: string) => void;
	onExited: (terminalId: string) => void;
	onReplace: (terminalId: string) => void;
	onSessionEnded: () => void;
	onLeave: () => void;
	/** The zone to shade while a pane is being dragged over this one. */
	dropEdge?: DropEdge | null;
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
	onClose,
	onExited,
	onReplace,
	onSessionEnded,
	onLeave,
	dropEdge = null,
}: TerminalLeafProps) {
	const [renaming, setRenaming] = useState(false);
	const [draft, setDraft] = useState(terminal.name);
	const field = useRef<HTMLInputElement | null>(null);
	const mountId = useRef(crypto.randomUUID());
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
				<MenuRoot>
					<MenuTrigger asChild={true}>
						<IconButton
							icon="more"
							label={`Actions for ${terminal.name}`}
							size="sm"
							data-testid={`terminal-actions-${terminal.id}`}
						/>
					</MenuTrigger>
					<Menu label={`Actions for ${terminal.name}`}>
						<MenuItem disabled={ended} onSelect={() => onSplit(terminal.id, "row")}>
							<span data-testid="split-right">Split right</span>
						</MenuItem>
						<MenuItem disabled={ended} onSelect={() => onSplit(terminal.id, "column")}>
							<span data-testid="split-down">Split down</span>
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
