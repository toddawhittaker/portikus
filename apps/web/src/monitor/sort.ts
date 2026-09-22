import type { UsageProcess } from "@portikus/contracts";

export type ProcessColumn = "pid" | "cpu" | "memory" | "command";
export type SortDirection = "asc" | "desc";

export interface ProcessSort {
	column: ProcessColumn;
	direction: SortDirection;
}

/** Busiest first, until a column header is clicked. */
export const DEFAULT_PROCESS_SORT: ProcessSort = {
	column: "cpu",
	direction: "desc",
};

export function toggleProcessSort(
	current: ProcessSort,
	column: ProcessColumn,
): ProcessSort {
	if (current.column === column) {
		return { column, direction: current.direction === "asc" ? "desc" : "asc" };
	}
	return { column, direction: "asc" };
}

/**
 * Compare one column. Numbers compare as numbers, including a missing CPU
 * sample, which sorts as less than zero. A tie falls through to pid so the
 * order stays stable.
 */
export function compareProcesses(
	left: UsageProcess,
	right: UsageProcess,
	sort: ProcessSort,
): number {
	const sign = sort.direction === "asc" ? 1 : -1;
	const byColumn = compareColumn(left, right, sort.column);
	if (byColumn !== 0) return byColumn * sign;
	return left.pid - right.pid;
}

function compareColumn(
	left: UsageProcess,
	right: UsageProcess,
	column: ProcessColumn,
): number {
	switch (column) {
		case "pid":
			return left.pid - right.pid;
		case "cpu":
			return (left.cpuPercent ?? -1) - (right.cpuPercent ?? -1);
		case "memory":
			return left.residentBytes - right.residentBytes;
		case "command":
			return left.command.localeCompare(right.command, undefined, {
				sensitivity: "base",
				numeric: true,
			});
	}
}
