/**
 * The server state behind the Checks pane (SPEC.md §18.1). The definitions
 * live in the project's own `.portikus/checks.json`, so editing them is an
 * ordinary file write through the file API rather than a settings call.
 */
import {
	CHECKS_FILE_DIR,
	CHECKS_FILE_PATH,
	type CheckDefinition,
	CheckHistoryOutput,
	CheckHistoryResponse,
	CheckRun,
	ChecksResponse,
} from "@portikus/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { request, toApiError } from "../api/request.js";

const base = (workspaceId: string, projectId: string) =>
	`/workspaces/${workspaceId}/projects/${projectId}`;

const checkKeys = {
	list: (workspaceId: string, projectId: string) =>
		["checks", workspaceId, projectId] as const,
	history: (workspaceId: string, projectId: string, checkId: string) =>
		["check-history", workspaceId, projectId, checkId] as const,
};

/** The kept runs of one check, newest first (SPEC.md §25). */
export function useCheckHistory(
	workspaceId: string,
	projectId: string,
	checkId: string,
) {
	return useQuery({
		queryKey: checkKeys.history(workspaceId, projectId, checkId),
		queryFn: () =>
			request(
				CheckHistoryResponse,
				`${base(workspaceId, projectId)}/checks/${checkId}/history`,
			),
	});
}

/** Read the history again, after a run of the check has finished. */
export function useRefreshCheckHistory(workspaceId: string, projectId: string) {
	const client = useQueryClient();
	return (checkId: string) =>
		client.invalidateQueries({
			queryKey: checkKeys.history(workspaceId, projectId, checkId),
		});
}

/** The kept output of one past run, as text, fetched when the student opens it. */
export function useCheckHistoryOutput(
	workspaceId: string,
	projectId: string,
	checkId: string,
	runId: string,
	enabled: boolean,
) {
	return useQuery({
		queryKey: [...checkKeys.history(workspaceId, projectId, checkId), runId, "output"],
		enabled,
		// A finished run's output never changes.
		staleTime: Number.POSITIVE_INFINITY,
		queryFn: async () => {
			const body = await request(
				CheckHistoryOutput,
				`${base(workspaceId, projectId)}/checks/${checkId}/history/${runId}/output`,
			);
			const bytes = Uint8Array.from(atob(body.output), (c) => c.charCodeAt(0));
			return new TextDecoder().decode(bytes);
		},
	});
}

/** The configured checks of one project, and what each last did. */
export function useChecks(workspaceId: string, projectId: string) {
	return useQuery({
		queryKey: checkKeys.list(workspaceId, projectId),
		queryFn: () => request(ChecksResponse, `${base(workspaceId, projectId)}/checks`),
	});
}

/** Start one check. A check already running comes back as a 409. */
export function useRunCheck(workspaceId: string, projectId: string) {
	const client = useQueryClient();
	return useMutation({
		mutationFn: (checkId: string) =>
			request(CheckRun, `${base(workspaceId, projectId)}/checks/${checkId}/runs`, {
				method: "POST",
			}),
		onSettled: () => {
			void client.invalidateQueries({
				queryKey: checkKeys.list(workspaceId, projectId),
			});
		},
	});
}

/** Stop the run that is going now. */
export function useStopCheck(workspaceId: string, projectId: string) {
	const client = useQueryClient();
	return useMutation({
		mutationFn: async (checkId: string) => {
			const response = await fetch(
				`${base(workspaceId, projectId)}/checks/${checkId}/runs/current`,
				{ method: "DELETE", credentials: "same-origin" },
			);
			if (!response.ok) throw await toApiError(response);
		},
		onSettled: () => {
			void client.invalidateQueries({
				queryKey: checkKeys.list(workspaceId, projectId),
			});
		},
	});
}

/** The URL of the project's checks file, for reading and writing. */
function checksFileUrl(workspaceId: string, projectId: string): string {
	return `${base(workspaceId, projectId)}/file?path=${encodeURIComponent(CHECKS_FILE_PATH)}`;
}

/**
 * Write `.portikus/checks.json`, creating the file and its folder the first
 * time. The write is conditional either way: on the etag just read, or on the
 * file not existing at all, so a file someone else changed is never silently
 * replaced (SPEC.md §11.2, §13.5).
 */
export function useSaveChecks(workspaceId: string, projectId: string) {
	const client = useQueryClient();
	return useMutation({
		mutationFn: async (checks: CheckDefinition[]) => {
			const url = checksFileUrl(workspaceId, projectId);
			const existing = await fetch(url, { credentials: "same-origin" });
			let condition: Record<string, string>;
			if (existing.ok) {
				condition = { "if-match": existing.headers.get("etag") ?? "*" };
			} else if (existing.status === 404) {
				// The folder may not be there yet; a folder that already exists
				// comes back as 409, which is not a problem here.
				const made = await fetch(`${base(workspaceId, projectId)}/mkdir`, {
					method: "POST",
					credentials: "same-origin",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ path: CHECKS_FILE_DIR }),
				});
				if (!made.ok && made.status !== 409) throw await toApiError(made);
				condition = { "if-none-match": "*" };
			} else {
				throw await toApiError(existing);
			}
			const body = `${JSON.stringify({ checks }, null, "\t")}\n`;
			const written = await fetch(url, {
				method: "PUT",
				credentials: "same-origin",
				headers: { ...condition, "content-type": "text/plain; charset=utf-8" },
				body,
			});
			if (!written.ok) throw await toApiError(written);
		},
		onSuccess: () => {
			void client.invalidateQueries({
				queryKey: checkKeys.list(workspaceId, projectId),
			});
		},
	});
}
