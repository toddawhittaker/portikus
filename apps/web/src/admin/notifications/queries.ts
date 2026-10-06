import {
	AdminNotifications,
	type AlertChannelKind,
	type NotificationSettingsUpdate,
	NotifyJobView,
	TestAlertResponse,
} from "@portikus/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { request, sendJson } from "../../api/request.js";
import { isActive } from "./form.js";

const notificationsKey = ["admin", "notifications"] as const;

/** A queued or running job is polled every two seconds, as the certificate page does. */
const POLL_MS = 2000;

/**
 * The settings in force and the latest job; polled while that job is
 * unfinished, or while `waiting` for a job this page asked for.
 */
export function useNotifications(waiting: boolean) {
	return useQuery({
		queryKey: notificationsKey,
		queryFn: () => request(AdminNotifications, "/admin/notifications"),
		refetchInterval: (query) =>
			waiting || isActive(query.state.data?.job) ? POLL_MS : false,
		retry: false,
	});
}

/** The update may hold secrets: gcTime 0 and the caller's reset drop it once sent. */
export function useSaveNotifications() {
	const client = useQueryClient();
	return useMutation({
		gcTime: 0,
		mutationFn: (body: NotificationSettingsUpdate) =>
			sendJson(NotifyJobView, "/admin/notifications", body, "PUT"),
		onSuccess: () => client.invalidateQueries({ queryKey: notificationsKey }),
	});
}

/** One test alert to one saved channel. */
export function useTestAlert() {
	return useMutation({
		mutationFn: (channel: AlertChannelKind) =>
			sendJson(TestAlertResponse, "/admin/alerts/test", { channel }),
	});
}
