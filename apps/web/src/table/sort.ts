import type { SortDirection } from "@portikus/contracts";

export { type SortDirection, sortRows } from "@portikus/contracts";

/** Which column a table is sorted by, and which way; kept by the tab that owns the table. */
export interface SortState<C extends string> {
	column: C;
	direction: SortDirection;
}

/**
 * The sort after a header is pressed: the sorted column flips, and another
 * column starts at its own first direction (newest first for a time).
 */
export function nextSort<C extends string>(
	current: SortState<C>,
	column: C,
	first: SortDirection = "ascending",
): SortState<C> {
	if (current.column !== column) return { column, direction: first };
	return {
		column,
		direction: current.direction === "ascending" ? "descending" : "ascending",
	};
}

/** The caption's words for the sort, such as "sorted by Activity, descending". */
export function sortText(label: string, direction: SortDirection): string {
	return `sorted by ${label}, ${direction}`;
}
