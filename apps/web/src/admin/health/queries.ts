import { type HealthRange, HealthReport, HealthSeries } from "@portikus/contracts";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { request } from "../../api/request.js";

/** Platform health, refreshed every 30 seconds (SPEC.md §25.6). */
export function useHealth() {
	return useQuery({
		queryKey: ["admin", "health"],
		queryFn: () => request(HealthReport, "/admin/health"),
		refetchInterval: 30_000,
	});
}

/**
 * The report for the status bar and the rail's marks on every admin page.
 * It does not poll, since each read asks every workspace agent; the Health
 * tab's own 30 second refresh shares this cache entry and keeps it current.
 */
export function useHealthGlance() {
	return useQuery({
		queryKey: ["admin", "health"],
		queryFn: () => request(HealthReport, "/admin/health"),
		refetchInterval: false,
		staleTime: 5 * 60_000,
	});
}

/**
 * The same report for the site limits the workspace panel shows, without
 * polling: every refresh asks each workspace agent, and limits rarely change.
 */
export function useSiteLimits() {
	return useQuery({
		queryKey: ["admin", "health"],
		queryFn: () => request(HealthReport, "/admin/health"),
		refetchInterval: false,
		staleTime: 10 * 60_000,
	});
}

/** Every chart's data for one range, refreshed at the sample rate. */
export function useHealthSeries(range: HealthRange) {
	return useQuery({
		queryKey: ["admin", "health", "series", range],
		queryFn: () => request(HealthSeries, `/admin/health/series?range=${range}`),
		refetchInterval: 60_000,
		// Keep the old charts on screen while a new range loads.
		placeholderData: keepPreviousData,
	});
}
