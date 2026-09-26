import { type HealthRange, LogCounts, LogPage } from "@portikus/contracts";
import { keepPreviousData, useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { ApiError, request } from "../../api/request.js";
import { type LogFilters, logQueryString } from "./filters.js";

/** 30 seconds while only the newest page is shown and auto refresh is on. */
export function refreshInterval(pagesLoaded: number, auto = true): number | false {
	return !auto || pagesLoaded > 1 ? false : 30_000;
}

/** A busy journal is worth two more tries a second apart; an unavailable one is not. */
export function retryBusy(failures: number, error: unknown): boolean {
	return error instanceof ApiError && error.status === 429 && failures < 2;
}

export function logPagesKey(filters: LogFilters) {
	return ["admin", "logs", filters] as const;
}

/** An older page's cursor, and the time the first page resolved a preset window at. */
export interface LogPageParam {
	cursor: string;
	now: number;
}

/**
 * Pages of log lines, newest first. The first page refreshes every 30
 * seconds unless the admin paused it; once older pages are loaded the list
 * holds still (ruling 35). Older pages reuse the first page's time, so a
 * preset window such as "Last day" does not slide while paging.
 */
export function useLogPages(filters: LogFilters, auto = true) {
	return useInfiniteQuery({
		queryKey: logPagesKey(filters),
		queryFn: async ({ pageParam }) => {
			const now = pageParam?.now ?? Date.now();
			const page = await request(
				LogPage,
				`/admin/logs${logQueryString(filters, now, pageParam?.cursor ?? null)}`,
			);
			return { ...page, now };
		},
		initialPageParam: null as LogPageParam | null,
		getNextPageParam: (last): LogPageParam | undefined =>
			last.nextCursor ? { cursor: last.nextCursor, now: last.now } : undefined,
		refetchInterval: (query) =>
			refreshInterval(query.state.data?.pages.length ?? 0, auto),
		refetchOnWindowFocus: (query) =>
			refreshInterval(query.state.data?.pages.length ?? 0, auto) !== false,
		retry: retryBusy,
		retryDelay: 1_000,
	});
}

/** Error and warn lines per bucket for the Health tab's errors chart. */
export function useLogCounts(range: HealthRange) {
	return useQuery({
		queryKey: ["admin", "logs", "counts", range],
		queryFn: () => request(LogCounts, `/admin/logs/counts?range=${range}`),
		refetchInterval: 60_000,
		placeholderData: keepPreviousData,
		// The server answers a busy journal from memory, so this never gets a 429.
		retry: false,
	});
}
