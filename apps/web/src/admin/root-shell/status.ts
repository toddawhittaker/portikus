import { RootShellStatus } from "@portikus/contracts";
import { useQuery } from "@tanstack/react-query";
import { request } from "../../api/request.js";

/**
 * Whether this server offers root shells (ADR 0051). It changes only when
 * the operator reruns setup, which restarts the API, so it is read once.
 */
export function useRootShellStatus(enabled: boolean) {
	return useQuery({
		enabled,
		queryKey: ["admin", "root-shell"] as const,
		queryFn: () => request(RootShellStatus, "/admin/root-shell"),
		staleTime: Number.POSITIVE_INFINITY,
	});
}
