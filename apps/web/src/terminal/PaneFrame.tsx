/**
 * The frame around one terminal pane in a split: the title bar, which is
 * also the drag handle, the actions menu, and the drop area (SPEC.md §9.3).
 * What runs inside, and what the actions do, is the caller's.
 */
import { useDraggable, useDroppable } from "@dnd-kit/core";
import type { TerminalTheme } from "@portikus/contracts";
import {
	IconButton,
	Menu,
	MenuCheckboxItem,
	MenuItem,
	MenuRoot,
	MenuSeparator,
	MenuSub,
	MenuTrigger,
} from "@portikus/ui";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import type { DropEdge, SplitDirection } from "../layout/tree.js";
import type { SpeechInput } from "../voice/useSpeechInput.js";
import { VoiceButton } from "../voice/VoiceButton.js";
import { usePaneMenuFocus } from "../work/pointerDismiss.js";

/** The dnd-kit ids for one pane's drag handle and its drop area. */
function paneDragId(terminalId: string): string {
	return `pane-drag-${terminalId}`;
}

function paneDropId(terminalId: string): string {
	return `pane-drop-${terminalId}`;
}

export interface PaneFrameProps {
	terminalId: string;
	/** The name the actions menu is labelled with. */
	name: string;
	/** What the title bar shows and a drag carries. */
	title: string;
	/** The pane's own scheme, for its chrome; the page default when absent. */
	theme?: TerminalTheme;
	focused: boolean;
	/** A pane that has ended cannot be split. */
	ended: boolean;
	/** The only pane in its tab, which already has a tab of its own. */
	alone: boolean;
	/** The zone to shade while a pane is being dragged over this one. */
	dropEdge?: DropEdge | null;
	/** The other tabs this pane can join, named as the tab strip names them. */
	moveTargets: { tabId: string; label: string }[];
	onFocus: (terminalId: string) => void;
	onSplit: (terminalId: string, direction: SplitDirection) => void;
	/** Give this pane a tab of its own, the keyboard way to drag it. */
	onMoveToNewTab: (terminalId: string) => void;
	/** Put this pane into another tab's split, the click way to drag it there. */
	onMoveInto: (terminalId: string, tabId: string) => void;
	/** Share this tab's space out evenly again, the click way to drag splitters. */
	onResetSizes: () => void;
	onLeave: () => void;
	onClose: (terminalId: string) => void;
	/** Offers Rename in the menu when given. */
	onRename?: (terminalId: string, name: string) => void;
	/** Offers the light terminal switch in the menu when given with `theme`. */
	onSetTheme?: (terminalId: string, theme: TerminalTheme) => void;
	/** Offers the hold-to-talk microphone when given (SPEC.md §25.10). */
	voice?: SpeechInput;
	children: ReactNode;
}

const TERMINAL_HINT =
	"Hold Space on this button, or Alt+Shift+M in the terminal, to talk.";

export function PaneFrame({
	terminalId,
	name,
	title,
	theme,
	focused,
	ended,
	alone,
	dropEdge = null,
	moveTargets,
	onFocus,
	onSplit,
	onMoveToNewTab,
	onMoveInto,
	onResetSizes,
	onLeave,
	onClose,
	onRename,
	onSetTheme,
	voice,
	children,
}: PaneFrameProps) {
	const [renaming, setRenaming] = useState(false);
	const [draft, setDraft] = useState(name);
	const field = useRef<HTMLInputElement | null>(null);
	const mountId = useRef(crypto.randomUUID());
	const section = useRef<HTMLElement | null>(null);
	const actionsMenu = usePaneMenuFocus();
	// The menu returns focus to its trigger as it closes, so the field waits
	// for that to happen and only commits on a blur once it really had focus.
	const armed = useRef(false);
	// The title bar is the drag handle; the whole pane is a drop area
	// (SPEC.md §9.3).
	const drag = useDraggable({
		id: paneDragId(terminalId),
		data: { paneId: terminalId, title },
	});
	const drop = useDroppable({
		id: paneDropId(terminalId),
		data: { paneId: terminalId },
	});
	// Stable, so dnd-kit is not handed the node afresh on every render.
	const setDropNode = drop.setNodeRef;
	const sectionRef = useCallback(
		(node: HTMLElement | null) => {
			section.current = node;
			setDropNode(node);
		},
		[setDropNode],
	);

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
		const next = draft.trim();
		if (next.length > 0 && next !== name) onRename?.(terminalId, next);
		setRenaming(false);
	}

	return (
		<section
			ref={sectionRef}
			className={`pk-term ${focused ? "is-focused" : ""} ${drag.isDragging ? "is-dragged" : ""}`}
			aria-label={`Terminal: ${title}`}
			data-testid={`terminal-leaf-${terminalId}`}
			// The pane's own --terminal-* tokens, so the title bar and the
			// scrollbar follow this terminal rather than the per-user default
			// on the document.
			data-terminal-theme={theme}
			// Changes only when this pane is mounted again, which a test reads
			// to tell a move apart from a teardown and reconnect.
			data-mount-id={mountId.current}
			onFocusCapture={() => onFocus(terminalId)}
			onMouseDown={() => onFocus(terminalId)}
		>
			<div className="pk-term-bar">
				{renaming ? (
					<input
						ref={field}
						aria-label={`Rename ${name}`}
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
						data-testid={`terminal-handle-${terminalId}`}
						{...drag.listeners}
					>
						{title}
					</span>
				)}
				{voice ? (
					<VoiceButton
						testId={`terminal-voice-${terminalId}`}
						statusTestId={`terminal-voice-status-${terminalId}`}
						label={`Hold to talk into ${name}`}
						hint={TERMINAL_HINT}
						voice={voice}
						focusTarget={() =>
							section.current
								?.querySelector<HTMLElement>("textarea.xterm-helper-textarea")
								?.focus()
						}
					/>
				) : null}
				<MenuRoot onOpenChange={actionsMenu.onOpenChange}>
					<MenuTrigger asChild={true}>
						<IconButton
							icon="more"
							label={`Actions for ${name}`}
							size="sm"
							data-testid={`terminal-actions-${terminalId}`}
						/>
					</MenuTrigger>
					<Menu
						label={`Actions for ${name}`}
						onCloseAutoFocus={actionsMenu.onCloseAutoFocus}
					>
						<MenuItem disabled={ended} onSelect={() => onSplit(terminalId, "row")}>
							<span data-testid="split-right">Split right</span>
						</MenuItem>
						<MenuItem disabled={ended} onSelect={() => onSplit(terminalId, "column")}>
							<span data-testid="split-down">Split down</span>
						</MenuItem>
						<MenuItem disabled={alone} onSelect={() => onMoveToNewTab(terminalId)}>
							<span data-testid="terminal-move-to-new-tab">Move to new tab</span>
						</MenuItem>
						<MenuSub
							label="Move into"
							disabled={moveTargets.length === 0}
							testId="terminal-move-into"
						>
							{moveTargets.map((target) => (
								<MenuItem
									key={target.tabId}
									testId={`terminal-move-into-${target.tabId}`}
									onSelect={() => onMoveInto(terminalId, target.tabId)}
								>
									{target.label}
								</MenuItem>
							))}
						</MenuSub>
						<MenuItem disabled={alone} onSelect={onResetSizes}>
							<span data-testid="terminal-reset-sizes">Reset pane sizes</span>
						</MenuItem>
						{onRename || (onSetTheme && theme) ? <MenuSeparator /> : null}
						{onRename ? (
							<MenuItem
								onSelect={() => {
									setDraft(name);
									setRenaming(true);
								}}
							>
								<span data-testid="terminal-rename">Rename</span>
							</MenuItem>
						) : null}
						{onSetTheme && theme ? (
							<MenuCheckboxItem
								testId="terminal-theme-toggle"
								checked={theme === "light"}
								onCheckedChange={(light) =>
									onSetTheme(terminalId, light ? "light" : "dark")
								}
							>
								Light terminal
							</MenuCheckboxItem>
						) : null}
						<MenuSeparator />
						<MenuItem
							shortcut={["Alt", "Shift", "Q"]}
							onSelect={() => actionsMenu.thenFocus(onLeave)}
						>
							<span data-testid="terminal-leave">Leave terminal</span>
						</MenuItem>
						<MenuSeparator />
						{/* After the menu closes, so the caller can move the keyboard
						    off this pane instead of the menu returning it here. */}
						<MenuItem
							danger={true}
							onSelect={() => actionsMenu.thenFocus(() => onClose(terminalId))}
						>
							<span data-testid="terminal-close">Close</span>
						</MenuItem>
					</Menu>
				</MenuRoot>
			</div>
			{children}
			{voice && voice.state !== "listening" && voice.message !== "" ? (
				// The error seen as well as heard; the status region reads it.
				<p
					className="pk-term-voice-interim pk-term-voice-error"
					aria-hidden="true"
					data-testid={`terminal-voice-error-${terminalId}`}
				>
					{voice.message}
				</p>
			) : null}
			{voice && voice.interim !== "" ? (
				// Shown only: the status region says "Listening…" instead of
				// reading every guess aloud.
				<p
					className="pk-term-voice-interim"
					aria-hidden="true"
					data-testid={`terminal-voice-interim-${terminalId}`}
				>
					{voice.interim}
				</p>
			) : null}
			{dropEdge ? (
				<div
					className={`pk-term-drop pk-term-drop--${dropEdge}`}
					data-testid={`drop-zone-${terminalId}`}
					data-edge={dropEdge}
				/>
			) : null}
		</section>
	);
}
