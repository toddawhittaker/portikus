/**
 * The one usage sample the Monitor tab and a selected Running row share
 * (SPEC.md §18.2, §18.3). Polling stops when nothing is asking.
 */
import { WorkspaceUsage } from "@portikus/contracts";
import { useQuery } from "@tanstack/react-query";
import { request } from "../api/request.js";

/** How often a visible surface asks again. */
export const USAGE_POLL_MS = 1000;

export function useWorkspaceUsage(workspaceId: string, enabled: boolean) {
	return useQuery({
		queryKey: ["workspace-usage", workspaceId],
		enabled,
		staleTime: 0,
		refetchInterval: enabled ? USAGE_POLL_MS : false,
		queryFn: () => request(WorkspaceUsage, `/workspaces/${workspaceId}/usage`),
	});
}
