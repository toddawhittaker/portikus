import type * as React from "react";
import { cx } from "./cx.js";
import { Icon } from "./Icon.js";

export type WorkspaceState =
	| "provisioning"
	| "starting"
	| "running"
	| "stopping"
	| "stopped"
	| "error";
export type DesiredState = "running" | "stopped" | "restarting";
export type StateTone = WorkspaceState;

const STATE_LABEL: Record<WorkspaceState | "restarting", string> = {
	provisioning: "Setting up",
	starting: "Starting",
	running: "Running",
	stopping: "Stopping",
	stopped: "Stopped",
	error: "Error",
	restarting: "Restarting",
};

const TONE_TEXT: Record<StateTone, string> = {
	provisioning: "text-status-provisioning",
	starting: "text-status-starting",
	running: "text-status-running",
	stopping: "text-status-stopping",
	stopped: "text-status-stopped",
	error: "text-status-error",
};

const TONE_FILL: Record<StateTone, string> = {
	provisioning: "bg-status-provisioning-soft",
	starting: "bg-status-starting-soft",
	running: "bg-status-running-soft",
	stopping: "bg-status-stopping-soft",
	stopped: "bg-status-stopped-soft",
	error: "bg-status-error-soft",
};

/**
 * A difference between the desired state and the actual state is a transition, and
 * a transition is never shown as an error however long it takes (DESIGN.md section 6).
 */
export function resolveWorkspaceState(
	state: WorkspaceState,
	desiredState?: DesiredState,
): { tone: StateTone; label: string; moving: boolean } {
	if (state === "error")
		return { tone: "error", label: STATE_LABEL.error, moving: false };
	if (state === "provisioning" || state === "starting" || state === "stopping") {
		return {
			tone: state,
			label:
				desiredState === "restarting" ? STATE_LABEL.restarting : STATE_LABEL[state],
			moving: true,
		};
	}
	if (desiredState === "restarting")
		return { tone: "starting", label: STATE_LABEL.restarting, moving: true };
	if (state === "running" && desiredState === "stopped") {
		return { tone: "stopping", label: STATE_LABEL.stopping, moving: true };
	}
	if (state === "stopped" && desiredState === "running") {
		return { tone: "starting", label: STATE_LABEL.starting, moving: true };
	}
	return { tone: state, label: STATE_LABEL[state], moving: false };
}

export interface StateBadgeProps {
	state: WorkspaceState;
	desiredState?: DesiredState;
	/** Drops the soft fill, for status bars. */
	plain?: boolean;
	/** Announce changes politely. */
	live?: boolean;
	label?: string;
	className?: string;
}

export function StateBadge({
	state,
	desiredState,
	plain,
	live,
	label,
	className,
}: StateBadgeProps): React.ReactElement {
	const resolved = resolveWorkspaceState(state, desiredState);
	const glyph = resolved.moving ? (
		<span className="pk-spin" aria-hidden={true} />
	) : resolved.tone === "error" ? (
		<Icon name="alert" size="sm" />
	) : resolved.tone === "stopped" ? (
		<span
			className="pk-badge-ring box-border size-2 rounded-full border-[1.5px] border-current"
			aria-hidden={true}
		/>
	) : (
		<span className="pk-badge-dot size-2 rounded-full bg-current" aria-hidden={true} />
	);
	return (
		<span
			className={cx(
				"pk-badge inline-flex h-[22px] items-center gap-1.5 whitespace-nowrap rounded-sm text-[12px] font-medium leading-4",
				TONE_TEXT[resolved.tone],
				plain ? "px-0" : cx(TONE_FILL[resolved.tone], "px-2"),
				className,
			)}
			role="status"
			aria-live={live ? "polite" : undefined}
			data-state={state}
			data-desired-state={desiredState}
		>
			{glyph}
			{label ?? resolved.label}
		</span>
	);
}
