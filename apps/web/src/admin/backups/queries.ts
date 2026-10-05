import {
	AdminBackups,
	BACKUP_KEY_FILE_NAME,
	BackupKeyStatus,
	type BackupKeyUpload,
	BackupKeyUploadResult,
	BackupRequestView,
	type BackupRestoreRequest,
} from "@portikus/contracts";
import {
	type QueryKey,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { request, sendJson, toApiError } from "../../api/request.js";
import { downloadBlob } from "../../common/download.js";
import { adminKeys } from "../queries.js";

const backupsKey = ["admin", "backups"] as const;

/** The host reports every 30 seconds, so a few seconds keeps the page current. */
const BACKUPS_REFRESH_MS = 5000;

/** The Backups tab's status, sets, VM listing and recent requests (SPEC.md §24.9). */
export function useAdminBackups() {
	return useQuery({
		queryKey: backupsKey,
		queryFn: () => request(AdminBackups, "/admin/backups"),
		refetchInterval: BACKUPS_REFRESH_MS,
	});
}

/**
 * Every write answers 202 with the request it recorded. `alsoRefresh` names
 * another list the write changes.
 */
function useBackupWrite<T>(
	toRequest: (input: T) => [string, RequestInit],
	alsoRefresh?: QueryKey,
) {
	const client = useQueryClient();
	return useMutation({
		mutationFn: (input: T) => {
			const [path, init] = toRequest(input);
			return request(BackupRequestView, path, init);
		},
		onSuccess: () => {
			void client.invalidateQueries({ queryKey: backupsKey });
			if (alsoRefresh) void client.invalidateQueries({ queryKey: alsoRefresh });
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

/** Also refreshes the Users list, so the admin page sees the replace pending and watches it end. */
export function useReplaceHome() {
	return useBackupWrite<string>(
		(restoreId) => [
			`/admin/backups/restores/${encodeURIComponent(restoreId)}/replace-home`,
			{ method: "POST" },
		],
		adminKeys.users,
	);
}

export function useDeleteSnapshot() {
	return useBackupWrite<{ volume: string; snapshot: string }>(
		({ volume, snapshot }) => [
			`/admin/backups/snapshots/${encodeURIComponent(volume)}/${encodeURIComponent(snapshot)}`,
			del,
		],
	);
}

const backupKeyKey = ["admin", "backups", "key"] as const;

/**
 * The server-held backup key (ADR 0044). Asked once, not polled: each ask
 * starts a root helper on the server. A 404 means a separate host backs
 * this site up and holds the key itself.
 */
export function useBackupKey() {
	return useQuery({
		queryKey: backupKeyKey,
		queryFn: () => request(BackupKeyStatus, "/admin/backups/key"),
		retry: false,
		staleTime: Number.POSITIVE_INFINITY,
		refetchOnWindowFocus: false,
	});
}

/** Fetch the key and hand it to the browser as a file; nothing keeps a copy. */
export function useDownloadBackupKey() {
	const client = useQueryClient();
	return useMutation({
		mutationFn: async () => {
			const response = await fetch("/admin/backups/key/download", {
				method: "POST",
				credentials: "same-origin",
				cache: "no-store",
			});
			if (!response.ok) throw await toApiError(response);
			downloadBlob(BACKUP_KEY_FILE_NAME, await response.blob());
		},
		onSettled: () => {
			void client.invalidateQueries({ queryKey: backupKeyKey });
		},
	});
}

export function useUploadBackupKey() {
	const client = useQueryClient();
	return useMutation({
		mutationFn: (body: BackupKeyUpload) =>
			sendJson(BackupKeyUploadResult, "/admin/backups/key", body),
		onSuccess: (result) => {
			client.setQueryData(backupKeyKey, result.key);
		},
	});
}

export function useDeleteKeptHome() {
	return useBackupWrite<string>((volume) => [
		`/admin/backups/kept-homes/${encodeURIComponent(volume)}`,
		del,
	]);
}
