import { z } from "zod";

/**
 * A user's notification history: every toast the browser showed them, kept on
 * the server so it follows them across devices (SPEC.md section 8.5, ADR 0033).
 */

export const NotificationTone = z.enum(["neutral", "success", "warning", "danger"]);
export type NotificationTone = z.infer<typeof NotificationTone>;

/** Longest title and body a notification keeps, so a runaway tab cannot fill the table. */
export const MAX_NOTIFICATION_TITLE_LENGTH = 200;
export const MAX_NOTIFICATION_BODY_LENGTH = 2000;

/** The most notifications kept per user; the worker deletes older ones. */
export const MAX_NOTIFICATIONS_PER_USER = 200;

/** One page of `GET /me/notifications` at most. */
export const MAX_NOTIFICATIONS_PAGE = 100;

export const Notification = z.object({
	id: z.string().uuid(),
	tone: NotificationTone,
	title: z.string(),
	body: z.string(),
	createdAt: z.string().datetime(),
	readAt: z.string().datetime().nullable(),
});
export type Notification = z.infer<typeof Notification>;

/** `GET /me/notifications?limit=&before=`: newest first. */
export const ListNotificationsQuery = z.object({
	limit: z.coerce.number().int().min(1).max(MAX_NOTIFICATIONS_PAGE).default(50),
	/** Returns notifications created before this time, for the next page. */
	before: z.string().datetime().optional(),
});
export type ListNotificationsQuery = z.infer<typeof ListNotificationsQuery>;

export const NotificationList = z.object({
	notifications: z.array(Notification),
	unreadCount: z.number().int().nonnegative(),
});
export type NotificationList = z.infer<typeof NotificationList>;

/** `POST /me/notifications`: the browser records a toast it showed. */
export const RecordNotificationRequest = z.object({
	tone: NotificationTone,
	title: z.string().min(1).max(MAX_NOTIFICATION_TITLE_LENGTH),
	body: z.string().max(MAX_NOTIFICATION_BODY_LENGTH).default(""),
});
export type RecordNotificationRequest = z.input<typeof RecordNotificationRequest>;

/** `PATCH /me/notifications/:id`: only marking read is supported. */
export const UpdateNotificationRequest = z.object({ read: z.literal(true) });
export type UpdateNotificationRequest = z.infer<typeof UpdateNotificationRequest>;
