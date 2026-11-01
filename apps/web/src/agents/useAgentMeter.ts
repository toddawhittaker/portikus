import { AgentMeter } from "@portikus/contracts";
import { useQuery } from "@tanstack/react-query";
import { request } from "../api/request.js";

/** How often the open workspace page asks; the counts behind it change every few minutes. */
const AGENT_METER_POLL_MS = 60_000;

/** Each coding agent's plan limits and today's counts (SPEC.md §25.10). */
export function useAgentMeter(workspaceId: string, enabled: boolean) {
	return useQuery({
		queryKey: ["agent-meter", workspaceId],
		enabled,
		staleTime: 0,
		refetchInterval: enabled ? AGENT_METER_POLL_MS : false,
		queryFn: () => request(AgentMeter, `/workspaces/${workspaceId}/agent-meter`),
	});
}
