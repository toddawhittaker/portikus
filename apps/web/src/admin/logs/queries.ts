import { type HealthRange, LogCounts, LogPage } from "@portikus/contracts";
import { keepPreviousData, useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { ApiError, request } from "../../api/request.js";
import { type LogFilters, logQueryString } from "./filters.js";

/** 30 seconds while only the newest page is shown; paused once older ones are. */
export function refreshInterval(pagesLoaded: number): number | false {
	return pagesLoaded > 1 ? false : 30_000;
}

/** A busy journal is worth two more tries a second apart; an unavailable one is not. */
export function retryBusy(failures: number, error: unknown): boolean {
	return error instanceof ApiError && error.status === 429 && failures < 2;
}

export function logPagesKey(filters: LogFilters) {
	return ["admin", "logs", filters] as const;
}

/**
 * Pages of log lines, newest first. The first page refreshes every 30
 * seconds; once older pages are loaded the list holds still (ruling 35).
 */
export function useLogPages(filters: LogFilters) {
	return useInfiniteQuery({
		queryKey: logPagesKey(filters),
		queryFn: ({ pageParam }) =>
			request(LogPage, `/admin/logs${logQueryString(filters, Date.now(), pageParam)}`),
		initialPageParam: null as string | null,
		getNextPageParam: (last) => last.nextCursor ?? undefined,
		refetchInterval: (query) => refreshInterval(query.state.data?.pages.length ?? 0),
		refetchOnWindowFocus: (query) =>
			refreshInterval(query.state.data?.pages.length ?? 0) !== false,
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
		retry: retryBusy,
		retryDelay: 1_000,
	});
}
