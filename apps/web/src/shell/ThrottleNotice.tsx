import type { WorkspaceCpuThrottle } from "@portikus/contracts";
import { Button, Icon, IconButton } from "@portikus/ui";
import type { RefObject } from "react";
import { useFocusFallback } from "./useFocusFallback.js";

const THROTTLE_TITLE = "Your workspace has been slowed down";

function throttleBody(throttle: WorkspaceCpuThrottle): string {
	const lift =
		throttle.idleLiftMinutes !== null && throttle.idleLiftPercent !== null
			? ` It returns to full speed on its own after ${throttle.idleLiftMinutes} minutes under ${throttle.idleLiftPercent}% use.`
			: "";
	const restart = throttle.held
		? ` It stays slowed after a restart because it was slowed ${throttle.held.count} times in the last ${throttle.held.hours} hours. An administrator can lift this.`
		: " Stopping and starting the workspace restores full speed; an administrator can also lift this.";
	return `It kept its CPUs more than ${throttle.thresholdPercent}% busy for ${throttle.windowMinutes} minutes, so it now gets ${throttle.sharePercent}% of its usual CPU.${lift}${restart}`;
}

/**
 * The words for the page's always-mounted status region: a live region that
 * arrives already filled may not be announced.
 */
export function throttleAnnouncement(throttle: WorkspaceCpuThrottle): string {
	return `${THROTTLE_TITLE}. ${throttleBody(throttle)}`;
}

/**
 * Shown while the resource guard has slowed the workspace (ADR 0032). The
 * numbers come from the throttle row. Dismissing it lasts for the page's life.
 */
export function ThrottleNotice({
	throttle,
	onDismiss,
	onOpenWorkspace,
	onShowMonitor,
	fallbackFocus,
}: {
	throttle: WorkspaceCpuThrottle;
	onDismiss: () => void;
	/** Opens the workspace dialog with its restart confirmation on top. */
	onOpenWorkspace: () => void;
	/** Opens Monitor sorted by CPU, busiest first. */
	onShowMonitor: () => void;
	/** Takes focus if the notice goes away on its own while holding it. */
	fallbackFocus?: RefObject<HTMLElement | null>;
}) {
	const ref = useFocusFallback<HTMLDivElement>(fallbackFocus);
	return (
		<div
			ref={ref}
			className="pk-notice pk-notice--warning"
			data-testid="throttle-notice"
		>
			<span className="pk-notice-icon">
				<Icon name="alert" size="md" />
			</span>
			<div className="pk-notice-main">
				<p className="pk-notice-title">{THROTTLE_TITLE}</p>
				<p className="pk-notice-body">{throttleBody(throttle)}</p>
			</div>
			<div className="pk-notice-actions">
				<Button size="sm" data-testid="throttle-show-monitor" onClick={onShowMonitor}>
					See what's using CPU
				</Button>
				<Button
					size="sm"
					aria-haspopup="dialog"
					data-testid="throttle-restart"
					onClick={onOpenWorkspace}
				>
					Restart workspace…
				</Button>
				<IconButton
					icon="x"
					size="sm"
					label="Dismiss the slowed-down notice"
					data-testid="throttle-dismiss"
					onClick={onDismiss}
				/>
			</div>
		</div>
	);
}
