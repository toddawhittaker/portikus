import { Button, Icon } from "@portikus/ui";
import { stopTime, useCountdown } from "./useCountdown.js";

/**
 * What a screen reader hears once when the grace timer starts. It names the
 * stop time rather than the minutes left, so it never changes as they tick
 * (SPEC.md §25.8).
 */
export function disconnectAnnouncement(deadline: string): string {
	const target = Date.parse(deadline);
	// A deadline already past has no stop ahead to warn of.
	if (Number.isNaN(target) || target <= Date.now()) return "";
	return `You're disconnected. Your workspace will stop at ${stopTime(target)} unless a window reconnects.`;
}

/**
 * Shown while the workspace has no connected browser and the grace timer is
 * running (SPEC.md §6.4). Reconnecting from any window cancels the stop.
 * Not a live region: the page announces it through `disconnectAnnouncement`.
 */
export function DisconnectNotice({
	deadline,
	onReconnect,
}: {
	deadline: string;
	onReconnect: () => void;
}) {
	const countdown = useCountdown(deadline);
	if (!countdown) return null;

	return (
		<div className="pk-notice pk-notice--warning" data-testid="disconnect-notice">
			<span className="pk-notice-icon">
				<Icon name="alert" size="md" />
			</span>
			<div className="pk-notice-main">
				<p className="pk-notice-title">You're disconnected from your workspace</p>
				<p className="pk-notice-body">
					Portikus is trying to reconnect. If no window reconnects, your workspace will
					stop in{" "}
					<strong>
						{countdown.minutes} {countdown.minutes === 1 ? "minute" : "minutes"}
					</strong>
					, at {countdown.at}. Your files are saved; running terminals and previews will
					end.
				</p>
			</div>
			<div className="pk-notice-actions">
				<Button variant="secondary" size="sm" onClick={onReconnect}>
					Reconnect now
				</Button>
			</div>
		</div>
	);
}
