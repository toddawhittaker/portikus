/** Recovery points of one project, and Reset Docker (SPEC.md §15, §16.4). */
import { RecoveryPointList } from "@portikus/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { request } from "../api/request.js";

const base = (workspaceId: string, projectId: string) =>
	`/workspaces/${workspaceId}/projects/${projectId}/recovery-points`;

export const recoveryKeys = {
	list: (workspaceId: string, projectId: string) =>
		["recovery-points", workspaceId, projectId] as const,
};

export function useRecoveryPoints(workspaceId: string, projectId: string) {
	return useQuery({
		queryKey: recoveryKeys.list(workspaceId, projectId),
		queryFn: () => request(RecoveryPointList, base(workspaceId, projectId)),
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
	const invalidate = useInvalidate(workspaceId, projectId);
	return useMutation({
		mutationFn: ({
			pointId,
			skipSafetyPoint,
		}: {
			pointId: string;
			skipSafetyPoint: boolean;
		}) =>
			request(z.unknown(), `${base(workspaceId, projectId)}/${pointId}/restore`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(skipSafetyPoint ? { skipSafetyPoint: true } : {}),
			}),
		onSettled: invalidate,
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
