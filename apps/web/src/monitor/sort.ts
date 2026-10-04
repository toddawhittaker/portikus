import type { UsageProcess } from "@portikus/contracts";
import type { SortState } from "../table/sort.js";

export type ProcessColumn = "pid" | "cpu" | "memory" | "command";

export type ProcessSort = SortState<ProcessColumn>;

/** The header words, also spoken when the sort changes. */
export const PROCESS_COLUMN_LABELS: Record<ProcessColumn, string> = {
	pid: "PID",
	cpu: "CPU",
	memory: "Memory",
	command: "Command",
};

/** Busiest first, until a column header is clicked. */
export const DEFAULT_PROCESS_SORT: ProcessSort = {
	column: "cpu",
	direction: "descending",
};

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
	const sign = sort.direction === "ascending" ? 1 : -1;
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

/**
 * `rows` in the order `keys` names, with rows it does not name after them in
 * their own order. Holds the list still while focus is inside it (SPEC.md
 * §25.8), so the row under a keyboard user does not move.
 */
export function keepOrder<T>(
	rows: readonly T[],
	keys: readonly string[],
	keyOf: (row: T) => string,
): T[] {
	const rank = new Map(keys.map((key, index) => [key, index]));
	const known = rows
		.filter((row) => rank.has(keyOf(row)))
		.sort(
			(left, right) => (rank.get(keyOf(left)) ?? 0) - (rank.get(keyOf(right)) ?? 0),
		);
	return [...known, ...rows.filter((row) => !rank.has(keyOf(row)))];
}
