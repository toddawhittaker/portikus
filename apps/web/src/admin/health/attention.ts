import {
	type HealthReport,
	POOL_WARN_PERCENT,
	poolFillPercent,
} from "@portikus/contracts";
import { WARN_AT } from "../../monitor/format.js";

export function usedPercent(used: number, total: number): number {
	return total > 0 ? Math.round((used / total) * 100) : 0;
}

/** The memory warning, at the share where the meters turn amber. */
export const MEMORY_WARNING = `Memory is over ${Math.round(WARN_AT * 100)}% full`;

export function isNearlyFull(used: number, total: number): boolean {
	return total > 0 && used / total >= WARN_AT;
}

/** Names metadata when it, not data, is the figure over the line. */
export function poolWarning(pool: {
	usedBytes: number;
	totalBytes: number;
	metadataPercent: number | null;
}): string | null {
	if (poolFillPercent(pool) < POOL_WARN_PERCENT) return null;
	const data = pool.totalBytes > 0 ? (pool.usedBytes / pool.totalBytes) * 100 : 0;
	return (pool.metadataPercent ?? 0) > data
		? `Storage pool metadata is over ${POOL_WARN_PERCENT}% full`
		: `Storage pool is over ${POOL_WARN_PERCENT}% full`;
}

/** A problem the report marks, and where to look into it. */
export interface HealthProblem {
	text: string;
	action: string;
	tab: "logs" | "users";
	search: Record<string, string>;
}

/**
 * The problems an administrator should act on, most pressing first, besides
 * guarded workspaces (SPEC.md section 25.6).
 */
export function healthProblems(report: HealthReport): HealthProblem[] {
	const problems: HealthProblem[] = [];
	const logs = (text: string): HealthProblem => ({
		text,
		action: "Open Logs",
		tab: "logs",
		search: { level: "error,warn", since: "24h" },
	});
	if (!report.controller.reachable) problems.push(logs("Controller not reachable"));
	if (report.agents.answering < report.agents.running) {
		const silent = report.agents.running - report.agents.answering;
		problems.push({
			text: `${silent} workspace agent${silent === 1 ? "" : "s"} not answering`,
			action: "Open Users",
			tab: "users",
			search: {},
		});
	}
	const failures = Object.values(report.last24h).reduce((sum, n) => sum + n, 0);
	if (failures > 0) {
		problems.push(
			logs(`${failures} failure${failures === 1 ? "" : "s"} in the last 24 hours`),
		);
	}
	const { host } = report;
	if (host && isNearlyFull(host.memory.usedBytes, host.memory.totalBytes)) {
		problems.push({
			text: MEMORY_WARNING,
			action: "Open Users",
			tab: "users",
			search: {},
		});
	}
	const pool = host ? poolWarning(host.pool) : null;
	if (pool)
		problems.push({ text: pool, action: "Open Users", tab: "users", search: {} });
	return problems;
}

/** One row per throttle or memory flag, a workspace with both getting two. */
export function guardRows(guard: HealthReport["guard"]) {
	return guard.flatMap((entry) => [
		...(entry.cpuThrottle
			? [
					{
						key: `${entry.workspaceId}-cpu`,
						workspaceId: entry.workspaceId,
						owner: entry.owner,
						which: "Throttled",
						held: entry.cpuThrottle.held !== undefined,
						at: entry.cpuThrottle.at,
						average: `CPU ${Math.round(entry.cpuThrottle.averagePercent)}% over ${entry.cpuThrottle.windowMinutes} minutes`,
					},
				]
			: []),
		...(entry.memoryFlag
			? [
					{
						key: `${entry.workspaceId}-memory`,
						workspaceId: entry.workspaceId,
						owner: entry.owner,
						which: "High memory",
						held: false,
						at: entry.memoryFlag.at,
						average: `Memory ${Math.round(entry.memoryFlag.averagePercent)}% over ${entry.memoryFlag.windowMinutes} minutes`,
					},
				]
			: []),
	]);
}

type GuardRow = ReturnType<typeof guardRows>[number];

/** Everything on the Health tab's Needs attention list, and how many rows that is. */
export interface Attention {
	guard: GuardRow[];
	problems: HealthProblem[];
	count: number;
}

/**
 * The one list the Health rail mark, the status bar and the Needs attention
 * list all read, so their counts cannot disagree (SPEC.md section 25.6).
 */
export function attentionOf(report: HealthReport): Attention {
	const guard = guardRows(report.guard);
	const problems = healthProblems(report);
	return { guard, problems, count: guard.length + problems.length };
}
