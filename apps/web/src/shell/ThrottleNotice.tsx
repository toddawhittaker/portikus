import type { WorkspaceCpuThrottle } from "@portikus/contracts";
import { Button, Icon, IconButton } from "@portikus/ui";

export const THROTTLE_TITLE = "Your workspace has been slowed down";

export function throttleBody(throttle: WorkspaceCpuThrottle): string {
	const lift =
		throttle.idleLiftMinutes !== null && throttle.idleLiftPercent !== null
			? ` It returns to full speed on its own after ${throttle.idleLiftMinutes} minutes under ${throttle.idleLiftPercent}% use.`
			: "";
	return `It kept its CPUs more than ${throttle.thresholdPercent}% busy for ${throttle.windowMinutes} minutes, so it now gets ${throttle.sharePercent}% of its usual CPU.${lift} Stopping and starting the workspace restores full speed; an administrator can also lift this.`;
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
}: {
	throttle: WorkspaceCpuThrottle;
	onDismiss: () => void;
	/** Opens the workspace dialog with its restart confirmation on top. */
	onOpenWorkspace: () => void;
	/** Opens Monitor sorted by CPU, busiest first. */
	onShowMonitor: () => void;
}) {
	return (
		<div className="pk-notice pk-notice--warning" data-testid="throttle-notice">
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
