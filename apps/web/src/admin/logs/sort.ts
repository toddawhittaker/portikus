import type { LogLine } from "@portikus/contracts";
import { type SortDirection, type SortState, sortRows } from "../table/sort.js";
import { field, SERVICE_LABELS } from "./line.js";

export type LogColumn = "time" | "level" | "service" | "code" | "status";

export const LOG_COLUMN_LABEL: Record<LogColumn, string> = {
	time: "Time",
	level: "Level",
	service: "Service",
	code: "Code",
	status: "Status",
};

/** The first press puts the newest, the most severe and the highest status on top. */
export const LOG_COLUMN_FIRST: Record<LogColumn, SortDirection> = {
	time: "descending",
	level: "descending",
	service: "ascending",
	code: "ascending",
	status: "descending",
};

/** Newest first, the order the journal returns. */
export const DEFAULT_LOG_SORT: SortState<LogColumn> = {
	column: "time",
	direction: "descending",
};

const SEVERITY: Record<string, number> = {
	debug: 0,
	info: 1,
	warn: 2,
	error: 3,
	fatal: 4,
};

function key(
	line: LogLine,
	column: Exclude<LogColumn, "time">,
): string | number | null {
	switch (column) {
		case "level":
			return SEVERITY[field(line.line, "level")] ?? null;
		case "service":
			return SERVICE_LABELS[line.service];
		case "code":
			return field(line.line, "code") || null;
		case "status": {
			const status = Number.parseInt(field(line.line, "status"), 10);
			return Number.isNaN(status) ? null : status;
		}
	}
}

/**
 * The loaded lines in the table's order. Only what is loaded is sorted, so
 * the caption says so; ties keep the journal's newest-first order. Time
 * follows the journal itself, so lines in the same millisecond keep their
 * order and simply reverse for oldest first.
 */
export function sortLogLines(
	lines: readonly LogLine[],
	sort: SortState<LogColumn>,
): LogLine[] {
	if (sort.column === "time") {
		return sort.direction === "descending" ? [...lines] : [...lines].reverse();
	}
	const column = sort.column;
	return sortRows(lines, (line) => key(line, column), sort.direction);
}
