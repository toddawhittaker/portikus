import type { MemoryFlag } from "@portikus/contracts";
import { Button, Icon, IconButton } from "@portikus/ui";

export const MEMORY_TITLE = "Your workspace has been near its memory limit";

export function memoryBody(flag: MemoryFlag): string {
	return `For ${flag.windowMinutes} minutes it used more than ${flag.thresholdPercent}% of its memory. If it runs out, the biggest program is stopped.`;
}

/** The words for the page's always-mounted status region, as for the throttle. */
export function memoryAnnouncement(flag: MemoryFlag): string {
	return `${MEMORY_TITLE}. ${memoryBody(flag)}`;
}

/**
 * Shown while the resource guard has flagged the workspace's memory use
 * (ADR 0032; docs/EPIC-21.md ruling 7). Dismissing it lasts for the page's life.
 */
export function MemoryNotice({
	flag,
	onDismiss,
	onShowMonitor,
}: {
	flag: MemoryFlag;
	onDismiss: () => void;
	/** Opens Monitor sorted by memory, largest first. */
	onShowMonitor: () => void;
}) {
	return (
		<div className="pk-notice pk-notice--warning" data-testid="memory-notice">
			<span className="pk-notice-icon">
				<Icon name="alert" size="md" />
			</span>
			<div className="pk-notice-main">
				<p className="pk-notice-title">{MEMORY_TITLE}</p>
				<p className="pk-notice-body">{memoryBody(flag)}</p>
			</div>
			<div className="pk-notice-actions">
				<Button size="sm" data-testid="memory-show-monitor" onClick={onShowMonitor}>
					See what's using memory
				</Button>
				<IconButton
					icon="x"
					size="sm"
					label="Dismiss the memory notice"
					data-testid="memory-dismiss"
					onClick={onDismiss}
				/>
			</div>
		</div>
	);
}
