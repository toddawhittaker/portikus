import {
	AdminModelPrice,
	AdminProxyHosts,
	PriceProposal,
	type PriceProposalDecision,
	type PriceRowInput,
	PriceRun,
} from "@portikus/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { request, sendJson } from "../../api/request.js";

const pricingKey = ["admin", "pricing"] as const;
const POLL_MS = 2000;

const AdminPricingView = z.object({
	prices: z.array(AdminModelPrice),
	run: PriceRun.nullable(),
	proposals: z.array(PriceProposal),
});
type AdminPricingView = z.infer<typeof AdminPricingView>;

const Prices = z.object({ prices: z.array(AdminModelPrice) });
const Decided = Prices.extend({ proposals: z.array(PriceProposal) });

/** The table, the last run and the pending proposals; polled while a run is going. */
export function useAdminPricing() {
	return useQuery({
		queryKey: pricingKey,
		queryFn: () => request(AdminPricingView, "/admin/pricing"),
		retry: false,
		refetchInterval: (query) =>
			query.state.data?.run?.status === "running" ? POLL_MS : false,
	});
}

function useMerge() {
	const client = useQueryClient();
	return (part: Partial<AdminPricingView>) =>
		client.setQueryData<AdminPricingView>(pricingKey, (old) =>
			old ? { ...old, ...part } : old,
		);
}

export function useRefresh() {
	const merge = useMerge();
	return useMutation({
		mutationFn: () => sendJson(PriceRun, "/admin/pricing/refresh", {}),
		onSuccess: (run) => merge({ run }),
	});
}

export function useDecide() {
	const merge = useMerge();
	return useMutation({
		mutationFn: ({ id, ...body }: { id: string } & PriceProposalDecision) =>
			sendJson(Decided, `/admin/pricing/proposals/${id}/decision`, body),
		onSuccess: merge,
	});
}

export function useSaveRow() {
	const merge = useMerge();
	return useMutation({
		mutationFn: ({ id, row }: { id: string | null; row: PriceRowInput }) =>
			id === null
				? sendJson(Prices, "/admin/pricing/rows", row)
				: sendJson(Prices, `/admin/pricing/rows/${id}`, row, "PUT"),
		onSuccess: merge,
	});
}

export function useDeleteRow() {
	const merge = useMerge();
	return useMutation({
		mutationFn: (id: string) =>
			request(Prices, `/admin/pricing/rows/${id}`, { method: "DELETE" }),
		onSuccess: merge,
	});
}

/** The server proxy host lists; absent (404) on a server without site jobs, where nothing is offered. */
export function useProxyHosts() {
	return useQuery({
		queryKey: ["admin", "proxy-hosts"],
		queryFn: () => request(AdminProxyHosts, "/admin/proxy-hosts"),
		retry: false,
	});
}
