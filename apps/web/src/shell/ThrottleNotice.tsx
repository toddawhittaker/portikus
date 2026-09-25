import type { WorkspaceCpuThrottle } from "@portikus/contracts";
import { Icon, IconButton } from "@portikus/ui";

/**
 * Shown while the resource guard has slowed the workspace (ADR 0032). The
 * numbers come from the throttle row. Dismissing it lasts for the page's life.
 */
export function ThrottleNotice({
	throttle,
	onDismiss,
}: {
	throttle: WorkspaceCpuThrottle;
	onDismiss: () => void;
}) {
	return (
		<div
			className="pk-notice pk-notice--warning"
			role="status"
			aria-live="polite"
			data-testid="throttle-notice"
		>
			<span className="pk-notice-icon">
				<Icon name="alert" size="md" />
			</span>
			<div className="pk-notice-main">
				<p className="pk-notice-title">Your workspace has been slowed down</p>
				<p className="pk-notice-body">
					It kept its CPUs more than {throttle.thresholdPercent}% busy for{" "}
					{throttle.windowMinutes} minutes, so it now gets {throttle.sharePercent}% of
					its usual CPU. Stopping and starting the workspace restores full speed; an
					administrator can also lift this.
				</p>
			</div>
			<div className="pk-notice-actions">
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
