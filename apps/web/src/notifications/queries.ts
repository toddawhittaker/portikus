import {
	MAX_NOTIFICATION_BODY_LENGTH,
	MAX_NOTIFICATION_TITLE_LENGTH,
	Notification,
	NotificationList,
} from "@portikus/contracts";
import type { ToastRecord } from "@portikus/ui";
import {
	type QueryClient,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { z } from "zod";
import { request } from "../api/request.js";

export const notificationsKey = ["me", "notifications"] as const;

/** How often the badge asks for the unread count (SPEC.md section 8.5). */
export const NOTIFICATIONS_POLL_MS = 30_000;

/**
 * The newest notifications and the unread count. Polled, and refetched when
 * the window regains focus, so a read on another device clears the badge here.
 */
export function useNotifications() {
	return useQuery({
		queryKey: notificationsKey,
		refetchInterval: NOTIFICATIONS_POLL_MS,
		// Always stale, so returning to the window asks at once.
		staleTime: 0,
		refetchOnWindowFocus: true,
		queryFn: () => request(NotificationList, "/me/notifications"),
	});
}

/**
 * Record a toast the user was shown. A failure (offline, signed out, rate
 * limited) is dropped: the toast is already on screen, and this never retries
 * or raises a second toast.
 */
export async function recordNotification(
	client: QueryClient,
	toast: ToastRecord,
): Promise<void> {
	if (toast.title.trim() === "") return;
	try {
		const response = await fetch("/me/notifications", {
			method: "POST",
			credentials: "same-origin",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				tone: toast.tone,
				title: toast.title.slice(0, MAX_NOTIFICATION_TITLE_LENGTH),
				body: toast.body.slice(0, MAX_NOTIFICATION_BODY_LENGTH),
			}),
		});
		if (response.ok) void client.invalidateQueries({ queryKey: notificationsKey });
	} catch {
		// Offline: nothing to do.
	}
}

function useNotificationMutation<T>(send: (input: T) => Promise<unknown>) {
	const client = useQueryClient();
	return useMutation({
		mutationFn: send,
		onSettled: () => client.invalidateQueries({ queryKey: notificationsKey }),
	});
}

export function useMarkNotificationRead() {
	return useNotificationMutation((id: string) =>
		request(Notification, `/me/notifications/${id}`, {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ read: true }),
		}),
	);
}

export function useMarkAllNotificationsRead() {
	return useNotificationMutation(() =>
		request(z.undefined(), "/me/notifications/read-all", { method: "POST" }),
	);
}

export function useClearNotifications() {
	return useNotificationMutation(() =>
		request(z.undefined(), "/me/notifications", { method: "DELETE" }),
	);
}
