import {
	AddressPlan,
	type AddressSettings,
	AdminAddress,
	CertificatePreflight,
	type SiteJobState,
	SiteJobView,
} from "@portikus/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { request, sendJson } from "../../api/request.js";

const addressKey = ["admin", "address"] as const;

const ADDRESS_POLL_MS = 2000;

/** A job the page waits on: queued, running, or a trial waiting for Keep. */
export function isOpen(state: SiteJobState | undefined): boolean {
	return state === "queued" || state === "running" || state === "trial";
}

/** The address in force and the newest address job; polled while one is open. */
export function useAdminAddress() {
	return useQuery({
		queryKey: addressKey,
		queryFn: () => request(AdminAddress, "/admin/address"),
		refetchInterval: (query) =>
			isOpen(query.state.data?.job?.state) ? ADDRESS_POLL_MS : false,
		retry: false,
	});
}

export function usePlan() {
	return useMutation({
		mutationFn: (body: AddressSettings) =>
			sendJson(AddressPlan, "/admin/address/plan", body),
	});
}

export function useAddressPreflight() {
	return useMutation({
		mutationFn: (body: AddressSettings) =>
			sendJson(CertificatePreflight, "/admin/address/preflight", body),
	});
}

/** Apply, Keep and Roll back each write one request for the root site job. */
export function useAddressJob() {
	const client = useQueryClient();
	return useMutation({
		mutationFn: (
			action: { kind: "apply"; body: AddressSettings } | { kind: "keep" | "rollback" },
		) =>
			sendJson(
				SiteJobView,
				`/admin/address/${action.kind}`,
				action.kind === "apply" ? action.body : {},
			),
		onSuccess: () => client.invalidateQueries({ queryKey: addressKey }),
	});
}
