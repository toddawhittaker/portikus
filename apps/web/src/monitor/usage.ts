/**
 * The one usage sample the Monitor tab and a selected Running row share
 * (SPEC.md §18.2, §18.3). Polling stops when nothing is asking.
 */
import { WorkspaceUsage } from "@portikus/contracts";
import { useQuery } from "@tanstack/react-query";
import { request } from "../api/request.js";

/** How often a visible surface asks again. */
export const USAGE_POLL_MS = 1000;

/** The status bar only watches storage and memory, so it asks far less often. */
export const STORAGE_POLL_MS = 30_000;

/** Until the first sample arrives, ask this often whatever the poll is. */
const FIRST_SAMPLE_POLL_MS = 2000;

/**
 * The interval for one poll: quick until there is a sample, because the
 * query client does not retry and a workspace's agent answers a little
 * after it reports running. `settled` ends the quick phase early.
 */
export function usagePollInterval(
	hasSample: boolean,
	pollMs: number,
	settled = false,
): number {
	return hasSample || settled ? pollMs : Math.min(pollMs, FIRST_SAMPLE_POLL_MS);
}

/** How close a process is to the workspace's limit. */
export type LoadLevel = "normal" | "high" | "near-limit";

/** A figure is heavy from this share of its limit, and near the limit from the next. */
const HEAVY_FROM = 0.5;
const NEAR_LIMIT_FROM = 0.8;

/** Null or zero limits are never tinted: with nothing to measure against, plain is honest. */
export function loadLevel(used: number | null, limit: number): LoadLevel {
	if (used === null || !(limit > 0)) return "normal";
	const share = used / limit;
	if (share >= NEAR_LIMIT_FROM) return "near-limit";
	return share >= HEAVY_FROM ? "high" : "normal";
}

/** A process's CPU is already a percent of the workspace's total CPU time. */
export function cpuLoad(cpuPercent: number | null): LoadLevel {
	return loadLevel(cpuPercent, 100);
}

export function useWorkspaceUsage(
	workspaceId: string,
	enabled: boolean,
	pollMs: number = USAGE_POLL_MS,
	/** For a workspace in error: its agent may never answer, so one failure ends the quick phase. */
	slowAfterFailure = false,
) {
	return useQuery({
		queryKey: ["workspace-usage", workspaceId],
		enabled,
		staleTime: 0,
		refetchInterval: enabled
			? (query) =>
					usagePollInterval(
						query.state.data !== undefined,
						pollMs,
						slowAfterFailure && query.state.errorUpdateCount > 0,
					)
			: false,
		queryFn: () => request(WorkspaceUsage, `/workspaces/${workspaceId}/usage`),
	});
}
