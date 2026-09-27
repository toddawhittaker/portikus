import {
	AdminEgressView,
	type EgressEntryRequest,
	type EgressMode,
	type EgressPresetId,
} from "@portikus/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, request } from "../../api/request.js";

export const egressKey = ["admin", "egress"] as const;

/** Poll fast while a change waits for the worker to apply it, slowly otherwise. */
export function egressRefreshMs(view: AdminEgressView | undefined): number {
	if (view && view.version !== (view.apply.appliedVersion ?? 0)) return 1_000;
	return 10_000;
}

/** The workspace egress policy, its apply status and the blocked names (SPEC.md section 20.1). */
export function useEgress() {
	return useQuery({
		queryKey: egressKey,
		queryFn: () => request(AdminEgressView, "/admin/egress"),
		refetchInterval: (query) => egressRefreshMs(query.state.data),
	});
}

/** True when another administrator changed the policy after this page loaded it. */
export function isStale(error: unknown): boolean {
	return error instanceof ApiError && error.code === "EGRESS_VERSION_STALE";
}

export function egressErrorText(error: unknown): string {
	if (isStale(error)) {
		return "Someone else changed the network policy, so it was reloaded. Check it and try again.";
	}
	if (error instanceof ApiError) return error.message;
	return "Something went wrong. Please try again.";
}

function send(method: string, url: string, body?: unknown): Promise<AdminEgressView> {
	return request(AdminEgressView, url, {
		method,
		...(body === undefined
			? {}
			: {
					headers: { "content-type": "application/json" },
					body: JSON.stringify(body),
				}),
	});
}

export type EgressWrite =
	| { kind: "mode"; version: number; mode: EgressMode }
	| { kind: "presets"; version: number; presets: EgressPresetId[] }
	| { kind: "ports"; version: number; ports: number[] }
	| { kind: "add"; entry: EgressEntryRequest }
	| { kind: "edit"; id: string; entry: EgressEntryRequest }
	| { kind: "remove"; version: number; id: string };

function perform(write: EgressWrite): Promise<AdminEgressView> {
	switch (write.kind) {
		case "mode":
			return send("PUT", "/admin/egress/mode", {
				version: write.version,
				mode: write.mode,
			});
		case "presets":
			return send("PUT", "/admin/egress/presets", {
				version: write.version,
				presets: write.presets,
			});
		case "ports":
			return send("PUT", "/admin/egress/ports", {
				version: write.version,
				ports: write.ports,
			});
		case "add":
			return send("POST", "/admin/egress/entries", write.entry);
		case "edit":
			return send("PUT", `/admin/egress/entries/${write.id}`, write.entry);
		case "remove":
			return send(
				"DELETE",
				`/admin/egress/entries/${write.id}?version=${write.version}`,
			);
	}
}

/**
 * Every policy write answers with the fresh view. A stale version reloads the
 * view, so the next try carries the current one.
 */
export function useEgressWrite() {
	const client = useQueryClient();
	return useMutation({
		mutationFn: perform,
		onSuccess: (view) => client.setQueryData(egressKey, view),
		onError: (error) => {
			if (isStale(error)) void client.invalidateQueries({ queryKey: egressKey });
		},
	});
}
