/**
 * The preview toolbar's "Pick an element" button (SPEC.md §14.6, §25.8).
 *
 * The agent that gets the pick is chosen before picking: with one agent pane
 * open the button starts at once, with several it asks which, and with none
 * it is disabled and says why. While picking it reads as pressed, and a
 * second press stops.
 */
import {
	Icon,
	IconButton,
	Menu,
	MenuItem,
	MenuRoot,
	MenuTrigger,
	Tooltip,
} from "@portikus/ui";
import { useId, useRef, useState } from "react";
import {
	type AgentDropTarget,
	useAgentDropTargets,
} from "../../agents/agentDropTargets.js";
import { useCourseProfile } from "../../editor/settingsQueries.js";
import { useAgentStatus } from "../../terminal/codingAgentStatus.js";
import type { PickMode } from "./usePickMode.js";

const LABEL = "Pick an element";
export const NO_AGENT_TEXT =
	"Open an agent terminal or chat to send it a picked element";
const NO_PAGE_TEXT = "The preview has to show a page before you can pick from it";

/**
 * The targets in the order their tabs come on the page, which is the order
 * their panes are drawn in; a target with no pane on the page goes last.
 */
export function inTabOrder(targets: readonly AgentDropTarget[]): AgentDropTarget[] {
	const pane = (target: AgentDropTarget) =>
		document.querySelector(
			`[data-testid="terminal-leaf-${CSS.escape(target.terminalId)}"]`,
		);
	return [...targets].sort((a, b) => {
		const first = pane(a);
		const second = pane(b);
		if (!first || !second) return first ? -1 : second ? 1 : 0;
		return first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING
			? -1
			: 1;
	});
}

/**
 * Each target's menu label: the name the left pane shows, with a chat's
 * title when it has one. Two that still read the same are numbered in order.
 */
export function menuLabels(
	targets: readonly AgentDropTarget[],
	titles: ReadonlyMap<string, string>,
): string[] {
	const named = targets.map((target) => {
		const title = titles.get(target.terminalId);
		return title ? `${target.label}: ${title}` : target.label;
	});
	const total = new Map<string, number>();
	for (const label of named) total.set(label, (total.get(label) ?? 0) + 1);
	const seen = new Map<string, number>();
	return named.map((label) => {
		if (total.get(label) === 1) return label;
		const n = (seen.get(label) ?? 0) + 1;
		seen.set(label, n);
		return `${label} ${n}`;
	});
}

export interface PickControlProps {
	pick: PickMode;
	/** Whether the frame is on show to pick from. */
	ready: boolean;
}

export function PickControl({ pick, ready }: PickControlProps) {
	const listed = useAgentDropTargets();
	const status = useAgentStatus();
	// Traditional hides agent features only (SPEC.md §8.7).
	const traditional = useCourseProfile() === "traditional";
	const [menuOpen, setMenuOpen] = useState(false);
	// The target chosen in the menu. The menu holds focus inside itself while
	// open, so picking starts once it has closed, in place of Radix handing
	// focus back to the button.
	const chosen = useRef<{ target: AgentDropTarget; label: string } | null>(null);
	const reasonId = useId();
	if (traditional) return null;

	const active = pick.state !== "idle";
	const targets = inTabOrder(listed);
	const titles = new Map<string, string>();
	for (const terminal of status.terminals)
		if (terminal.title) titles.set(terminal.terminalId, terminal.title);
	const labels = menuLabels(targets, titles);
	const reason = targets.length === 0 ? NO_AGENT_TEXT : ready ? null : NO_PAGE_TEXT;
	const disabled = reason !== null && !active;

	// Kept reachable by Tab and named with its reason, which the tooltip shows
	// on focus as well as hover (SPEC.md §25.8); a press does nothing.
	const button = disabled ? (
		<Tooltip
			decorative
			content={
				<>
					{LABEL}: {reason}
				</>
			}
		>
			<button
				type="button"
				className="pk-iconbtn pk-preview-pick-off pk-focus-ring relative inline-grid size-[var(--size-control-sm)] place-items-center rounded-sm border border-transparent bg-transparent p-0 text-ink-muted"
				aria-label={LABEL}
				aria-disabled="true"
				aria-pressed={false}
				aria-describedby={reasonId}
				data-testid="preview-pick"
			>
				<Icon name="map-pin" size="sm" />
			</button>
		</Tooltip>
	) : (
		<IconButton
			icon="map-pin"
			label={LABEL}
			size="sm"
			data-testid="preview-pick"
			aria-pressed={active}
			onClick={
				targets.length > 1 && !active
					? undefined
					: () => {
							if (active) pick.stop();
							else if (targets[0] && labels[0] !== undefined)
								pick.start(targets[0], labels[0]);
						}
			}
		/>
	);

	return (
		<span className="pk-preview-pick">
			{targets.length > 1 && !disabled ? (
				<MenuRoot
					open={menuOpen}
					onOpenChange={(open) => {
						// While picking, the press stops instead of asking again.
						if (open && active) {
							pick.stop();
							return;
						}
						setMenuOpen(open);
					}}
				>
					<MenuTrigger asChild>{button}</MenuTrigger>
					<Menu
						label="Send the picked element to"
						onCloseAutoFocus={(event) => {
							const picked = chosen.current;
							chosen.current = null;
							if (!picked) return;
							event.preventDefault();
							pick.start(picked.target, picked.label);
						}}
					>
						{targets.map((target, index) => (
							<MenuItem
								key={target.terminalId}
								testId={`preview-pick-target-${target.terminalId}`}
								onSelect={() => {
									chosen.current = { target, label: labels[index] ?? target.label };
								}}
							>
								{labels[index]}
							</MenuItem>
						))}
					</Menu>
				</MenuRoot>
			) : (
				button
			)}
			{disabled ? (
				<span id={reasonId} hidden>
					{reason}
				</span>
			) : null}
		</span>
	);
}
