import {
	AgentUsageResponse,
	type AgentUsageWindow,
	AiUsageResponse,
	PricingTable,
} from "@portikus/contracts";
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

/** The built-in assistant's usage over the last `days` days, and this month against the cap. */
export function useAiUsage(days: AgentUsageWindow) {
	return useQuery({
		queryKey: ["admin", "ai-usage", days],
		queryFn: () => request(AiUsageResponse, `/admin/ai-usage?days=${days}`),
		placeholderData: keepPreviousData,
	});
}

/** The model price table, for the dollar estimate beside each row. */
export function usePricingTable() {
	return useQuery({
		queryKey: ["pricing"],
		queryFn: () => request(PricingTable, "/pricing"),
		staleTime: 5 * 60_000,
	});
}
