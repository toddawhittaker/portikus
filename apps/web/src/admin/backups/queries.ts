import {
	AdminBackups,
	BackupRequestView,
	type BackupRestoreRequest,
} from "@portikus/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { request } from "../../api/request.js";

export const backupsKey = ["admin", "backups"] as const;

/** The host reports every 30 seconds, so a few seconds keeps the page current. */
export const BACKUPS_REFRESH_MS = 5000;

/** The Backups tab's status, sets, VM listing and recent requests (SPEC.md §24.9). */
export function useAdminBackups() {
	return useQuery({
		queryKey: backupsKey,
		queryFn: () => request(AdminBackups, "/admin/backups"),
		refetchInterval: BACKUPS_REFRESH_MS,
	});
}

/** Every write answers 202 with the request it recorded. */
function useBackupWrite<T>(toRequest: (input: T) => [string, RequestInit]) {
	const client = useQueryClient();
	return useMutation({
		mutationFn: (input: T) => {
			const [path, init] = toRequest(input);
			return request(BackupRequestView, path, init);
		},
		onSuccess: () => {
			void client.invalidateQueries({ queryKey: backupsKey });
		},
	});
}

const del: RequestInit = { method: "DELETE" };

export function useRunBackup() {
	return useBackupWrite<void>(() => ["/admin/backups/run", { method: "POST" }]);
}

export function useDeleteSet() {
	return useBackupWrite<string>((stamp) => [
		`/admin/backups/sets/${encodeURIComponent(stamp)}`,
		del,
	]);
}

export function useDeleteDump() {
	return useBackupWrite<string>((file) => [
		`/admin/backups/dumps/${encodeURIComponent(file)}`,
		del,
	]);
}

export function useRestoreCopy() {
	return useBackupWrite<BackupRestoreRequest>((body) => [
		"/admin/backups/restores",
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		},
	]);
}

export function useReplaceHome() {
	return useBackupWrite<string>((restoreId) => [
		`/admin/backups/restores/${encodeURIComponent(restoreId)}/replace-home`,
		{ method: "POST" },
	]);
}

export function useDeleteSnapshot() {
	return useBackupWrite<{ volume: string; snapshot: string }>(
		({ volume, snapshot }) => [
			`/admin/backups/snapshots/${encodeURIComponent(volume)}/${encodeURIComponent(snapshot)}`,
			del,
		],
	);
}

export function useDeleteKeptHome() {
	return useBackupWrite<string>((volume) => [
		`/admin/backups/kept-homes/${encodeURIComponent(volume)}`,
		del,
	]);
}
