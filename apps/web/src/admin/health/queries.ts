import { HealthReport } from "@portikus/contracts";
import { useQuery } from "@tanstack/react-query";
import { request } from "../../api/request.js";

/** Platform health, refreshed every 30 seconds (SPEC.md §25.6). */
export function useHealth() {
	return useQuery({
		queryKey: ["admin", "health"],
		queryFn: () => request(HealthReport, "/admin/health"),
		refetchInterval: 30_000,
	});
}
