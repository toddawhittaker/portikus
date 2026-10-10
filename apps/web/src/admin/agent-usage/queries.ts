import { AgentUsageResponse, type AgentUsageWindow } from "@portikus/contracts";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { request } from "../../api/request.js";

/** Everyone's coding-agent usage over the last `days` days (SPEC.md section 20.1). */
export function useAgentUsage(days: AgentUsageWindow) {
	return useQuery({
		queryKey: ["admin", "agent-usage", days],
		queryFn: () => request(AgentUsageResponse, `/admin/agent-usage?days=${days}`),
		placeholderData: keepPreviousData,
	});
}
