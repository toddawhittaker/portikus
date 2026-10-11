/** Recovery points of one project, and Reset Docker (SPEC.md §15, §16.4). */
import { RecoveryAsideList, RecoveryPointList } from "@portikus/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { request, sendJson } from "../api/request.js";

const base = (workspaceId: string, projectId: string) =>
	`/workspaces/${workspaceId}/projects/${projectId}/recovery-points`;

/** One file of a point against its working copy (SPEC.md §15.8, §12.6). */
export function recoveryPointDiffUrl(
	workspaceId: string,
	projectId: string,
	pointId: string,
	path: string,
): string {
	const query = new URLSearchParams({ path });
	return `${base(workspaceId, projectId)}/${pointId}/diff?${query}`;
}

export const recoveryKeys = {
	list: (workspaceId: string, projectId: string) =>
		["recovery-points", workspaceId, projectId] as const,
	asides: (workspaceId: string, projectId: string) =>
		["recovery-asides", workspaceId, projectId] as const,
	/**
	 * Outside the "git-diff" keys on purpose: a save or a file event must not
	 * start another archive read of up to a minute (SPEC.md §15.8).
	 */
	pointDiff: (workspaceId: string, projectId: string, pointId: string, path: string) =>
		["recovery-point-diff", workspaceId, projectId, pointId, path] as const,
};

/** The project's points; `enabled` holds the request until they are wanted. */
export function useRecoveryPoints(
	workspaceId: string,
	projectId: string,
	enabled = true,
) {
	return useQuery({
		queryKey: recoveryKeys.list(workspaceId, projectId),
		queryFn: () => request(RecoveryPointList, base(workspaceId, projectId)),
		enabled,
	});
}

function useInvalidate(workspaceId: string, projectId: string) {
	const client = useQueryClient();
	return () =>
		client.invalidateQueries({ queryKey: recoveryKeys.list(workspaceId, projectId) });
}

export function useCreateRecoveryPoint(workspaceId: string, projectId: string) {
	const invalidate = useInvalidate(workspaceId, projectId);
	return useMutation({
		mutationFn: () =>
			request(z.unknown(), base(workspaceId, projectId), { method: "POST" }),
		onSettled: invalidate,
	});
}

export function useRestoreRecoveryPoint(workspaceId: string, projectId: string) {
	const client = useQueryClient();
	const invalidatePoints = useInvalidate(workspaceId, projectId);
	// A restore that stops part way leaves a kept folder.
	const invalidate = () =>
		Promise.all([
			invalidatePoints(),
			client.invalidateQueries({
				queryKey: recoveryKeys.asides(workspaceId, projectId),
			}),
		]);
	return useMutation({
		mutationFn: ({
			pointId,
			skipSafetyPoint,
		}: {
			pointId: string;
			skipSafetyPoint: boolean;
		}) =>
			sendJson(
				z.unknown(),
				`${base(workspaceId, projectId)}/${pointId}/restore`,
				skipSafetyPoint ? { skipSafetyPoint: true } : {},
			),
		onSettled: invalidate,
	});
}

const asidesUrl = (workspaceId: string, projectId: string) =>
	`/workspaces/${workspaceId}/projects/${projectId}/recovery-asides`;

/** Folders failed restores of this project left in ~/projects (SPEC.md §15.10). */
export function useRecoveryAsides(workspaceId: string, projectId: string) {
	return useQuery({
		queryKey: recoveryKeys.asides(workspaceId, projectId),
		queryFn: () => request(RecoveryAsideList, asidesUrl(workspaceId, projectId)),
		// A stopped workspace answers 409; asking again does not help.
		retry: false,
	});
}

export function useDeleteRecoveryAside(workspaceId: string, projectId: string) {
	const client = useQueryClient();
	return useMutation({
		mutationFn: (pointId: string) =>
			request(z.unknown(), `${asidesUrl(workspaceId, projectId)}/${pointId}`, {
				method: "DELETE",
			}),
		onSettled: () =>
			client.invalidateQueries({
				queryKey: recoveryKeys.asides(workspaceId, projectId),
			}),
	});
}

/** The new state arrives over the presence socket, as with start and stop. */
export function useResetDocker(workspaceId: string) {
	return useMutation({
		mutationFn: () =>
			request(z.unknown(), `/workspaces/${workspaceId}/reset-docker`, {
				method: "POST",
			}),
	});
}
