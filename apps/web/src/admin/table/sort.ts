export type SortDirection = "ascending" | "descending";

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

/** A row's value in the sorted column; null when the row has none. */
export type SortKey = string | number | null;

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/**
 * The rows ordered by one value. Ties keep their incoming order, and rows
 * with no value go last either way, so flipping never brings blanks to the top.
 */
export function sortRows<T>(
	rows: readonly T[],
	key: (row: T) => SortKey,
	direction: SortDirection,
): T[] {
	const sign = direction === "ascending" ? 1 : -1;
	return [...rows].sort((a, b) => {
		const left = key(a);
		const right = key(b);
		if (left === null || right === null) {
			if (left === right) return 0;
			return left === null ? 1 : -1;
		}
		const order =
			typeof left === "number" && typeof right === "number"
				? left - right
				: collator.compare(String(left), String(right));
		return sign * order;
	});
}

/** The caption's words for the sort, such as "sorted by Activity, descending". */
export function sortText(label: string, direction: SortDirection): string {
	return `sorted by ${label}, ${direction}`;
}
