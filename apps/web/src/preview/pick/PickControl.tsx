/**
 * The preview toolbar's "Pick an element" button (SPEC.md §14.6, §25.8).
 *
 * The agent that gets the pick is chosen before picking: with one agent pane
 * open the button starts at once, with several it asks which, and with none
 * it is disabled and says why. While picking it reads as pressed, and a
 * second press stops.
 */
import { IconButton, Menu, MenuItem, MenuRoot, MenuTrigger } from "@portikus/ui";
import { useId, useState } from "react";
import {
	type AgentDropTarget,
	useAgentDropTargets,
} from "../../agents/agentDropTargets.js";
import { useCourseProfile } from "../../editor/settingsQueries.js";
import type { PickMode } from "./usePickMode.js";

const LABEL = "Pick an element";
export const NO_AGENT_TEXT =
	"Open an agent terminal or chat to send it a picked element";
const NO_PAGE_TEXT = "The preview has to show a page before you can pick from it";

/**
 * Each target's menu label. Two agents of one kind share a tab name, so
 * those are numbered in the order they opened.
 */
function menuLabels(targets: readonly AgentDropTarget[]): string[] {
	const total = new Map<string, number>();
	for (const target of targets)
		total.set(target.label, (total.get(target.label) ?? 0) + 1);
	const seen = new Map<string, number>();
	return targets.map((target) => {
		if (total.get(target.label) === 1) return target.label;
		const n = (seen.get(target.label) ?? 0) + 1;
		seen.set(target.label, n);
		return `${target.label} ${n}`;
	});
}

export interface PickControlProps {
	pick: PickMode;
	/** Whether the frame is on show to pick from. */
	ready: boolean;
}

export function PickControl({ pick, ready }: PickControlProps) {
	const targets = useAgentDropTargets();
	// Traditional hides agent features only (SPEC.md §8.7).
	const traditional = useCourseProfile() === "traditional";
	const [menuOpen, setMenuOpen] = useState(false);
	const reasonId = useId();
	if (traditional) return null;

	const active = pick.state !== "idle";
	const labels = menuLabels(targets);
	const reason = targets.length === 0 ? NO_AGENT_TEXT : ready ? null : NO_PAGE_TEXT;
	const disabled = reason !== null && !active;

	const button = (
		<IconButton
			icon="map-pin"
			label={LABEL}
			size="sm"
			data-testid="preview-pick"
			aria-pressed={active}
			aria-describedby={disabled ? reasonId : undefined}
			title={disabled ? (reason ?? undefined) : undefined}
			disabled={disabled}
			onClick={
				targets.length > 1 && !active
					? undefined
					: () => {
							if (active) pick.stop();
							else if (targets[0]) pick.start(targets[0]);
						}
			}
		/>
	);

	return (
		<span className="pk-preview-pick">
			{targets.length > 1 ? (
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
					<Menu label="Send the picked element to">
						{targets.map((target, index) => (
							<MenuItem
								key={target.terminalId}
								testId={`preview-pick-target-${target.terminalId}`}
								onSelect={() => pick.start(target)}
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
