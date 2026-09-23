import { AuditPage } from "@portikus/contracts";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { request } from "../../api/request.js";

/** The filters of the Audit tab; an empty string means "any". */
export interface AuditFilters {
	workspace: string;
	user: string;
	action: string;
}

/** The query string for `GET /admin/audit`, leaving out empty filters. */
export function auditQueryString(filters: AuditFilters, before: number | null): string {
	const params = new URLSearchParams();
	if (filters.workspace) params.set("workspace", filters.workspace);
	if (filters.user) params.set("user", filters.user);
	if (filters.action) params.set("action", filters.action);
	if (before !== null) params.set("before", String(before));
	const text = params.toString();
	return text ? `?${text}` : "";
}

/** One page of audit events, newest first (SPEC.md §24.11). */
export function useAuditPage(filters: AuditFilters, before: number | null) {
	return useQuery({
		queryKey: ["admin", "audit", filters, before],
		queryFn: () =>
			request(AuditPage, `/admin/audit${auditQueryString(filters, before)}`),
		placeholderData: keepPreviousData,
	});
}
