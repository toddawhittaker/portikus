import type { Notification, NotificationTone } from "@portikus/contracts";
import { Button, Dialog, DialogRoot, Icon, type IconName } from "@portikus/ui";
import {
	useClearNotifications,
	useMarkAllNotificationsRead,
	useMarkNotificationRead,
	useNotifications,
} from "./queries.js";

const TONE_ICON: Record<NotificationTone, IconName> = {
	neutral: "info",
	success: "check",
	warning: "alert",
	danger: "alert",
};

const TONE_NAME: Record<NotificationTone, string> = {
	neutral: "Information",
	success: "Success",
	warning: "Warning",
	danger: "Error",
};

/** "Just now", "4 min ago", "3 h ago", "2 days ago". */
export function relativeTime(iso: string, now: number): string {
	const minutes = Math.max(0, Math.floor((now - Date.parse(iso)) / 60_000));
	if (minutes < 1) return "Just now";
	if (minutes < 60) return `${minutes} min ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours} h ago`;
	const days = Math.floor(hours / 24);
	return days === 1 ? "1 day ago" : `${days} days ago`;
}

function NotificationItem({ item, now }: { item: Notification; now: number }) {
	const markRead = useMarkNotificationRead();
	const unread = item.readAt === null;
	return (
		<li
			className={`pk-notification pk-notification--${item.tone}${unread ? " pk-notification--unread" : ""}`}
			data-testid="notification"
			data-unread={unread ? "true" : "false"}
		>
			<Icon name={TONE_ICON[item.tone]} className="pk-notification-icon" />
			<div className="min-w-0 flex-1">
				<p className="m-0 font-semibold text-ink">
					<span className="sr-only">
						{unread ? "Unread. " : ""}
						{TONE_NAME[item.tone]}:{" "}
					</span>
					{item.title}
				</p>
				{item.body ? <p className="mt-0.5 mb-0 text-ink-muted">{item.body}</p> : null}
				<p className="mt-0.5 mb-0 text-xs text-ink-muted">
					<time
						dateTime={item.createdAt}
						title={new Date(item.createdAt).toLocaleString()}
					>
						{relativeTime(item.createdAt, now)}
					</time>
				</p>
			</div>
			{unread ? (
				<>
					<span className="pk-notification-dot" aria-hidden="true" />
					<Button
						size="sm"
						variant="quiet"
						loading={markRead.isPending}
						onClick={() => markRead.mutate(item.id)}
						aria-label={`Mark "${item.title}" as read`}
						data-testid="notification-mark-read"
					>
						Mark read
					</Button>
				</>
			) : null}
		</li>
	);
}

/**
 * The user's notification history, newest first (SPEC.md section 8.5).
 * Opening it marks nothing read; the user does that here.
 */
export function NotificationsDialog({ onClose }: { onClose: () => void }) {
	const query = useNotifications();
	const markAll = useMarkAllNotificationsRead();
	const clear = useClearNotifications();
	const items = query.data?.notifications ?? [];
	const unread = query.data?.unreadCount ?? 0;
	const now = Date.now();

	return (
		<DialogRoot open onOpenChange={(open) => !open && onClose()}>
			<Dialog
				testId="dialog-notifications"
				size="lg"
				title="Notifications"
				description={
					unread === 0
						? "Everything is read."
						: `${unread} unread notification${unread === 1 ? "" : "s"}.`
				}
				onClose={onClose}
				footer={
					<>
						<Button
							variant="secondary"
							disabled={items.length === 0}
							loading={clear.isPending}
							onClick={() => clear.mutate()}
							data-testid="notifications-clear"
						>
							Clear all
						</Button>
						<Button
							variant="secondary"
							disabled={unread === 0}
							loading={markAll.isPending}
							onClick={() => markAll.mutate()}
							data-testid="notifications-read-all"
						>
							Mark all as read
						</Button>
					</>
				}
			>
				{query.isPending ? (
					<p className="m-0 text-ink-muted">Loading notifications…</p>
				) : query.isError ? (
					<p className="m-0 text-ink-muted" role="alert">
						Notifications could not be loaded. Try again in a moment.
					</p>
				) : items.length === 0 ? (
					<p className="m-0 text-ink-muted" data-testid="notifications-empty">
						No notifications yet. Messages the platform shows you appear here.
					</p>
				) : (
					<ul className="pk-notification-list" aria-label="Notifications, newest first">
						{items.map((item) => (
							<NotificationItem key={item.id} item={item} now={now} />
						))}
					</ul>
				)}
			</Dialog>
		</DialogRoot>
	);
}
