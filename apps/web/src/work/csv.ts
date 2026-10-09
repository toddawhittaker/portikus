/** A CSV file read for the file tab's table view (SPEC.md §13.2). */
import { parseCsv } from "@portikus/contracts";

/** At most this many rows under the header are drawn, so a large file stays quick. */
export const CSV_ROW_LIMIT = 1000;

/** At most this many columns are drawn, so a line of a million commas cannot hang the tab. */
export const CSV_COLUMN_LIMIT = 200;

export interface CsvTable {
	/** The first record, read as the column names. */
	header: string[];
	/** Every record under the header, in file order. */
	rows: string[][];
	/** How many records sit under the header in the whole file. */
	total: number;
	/** How many columns are drawn: the widest record, at most the column limit. */
	columns: number;
	/** The widest record's field count, before the column limit. */
	totalColumns: number;
}

/**
 * The file as a header and its rows; null when it holds no records.
 * Throws CsvError when the file is not valid CSV.
 */
export function csvTable(text: string): CsvTable | null {
	const [header, ...body] = parseCsv(text);
	if (header === undefined) return null;
	let totalColumns = header.length;
	for (const row of body) totalColumns = Math.max(totalColumns, row.length);
	return {
		header: header.slice(0, CSV_COLUMN_LIMIT),
		rows: body.map((row) => row.slice(0, CSV_COLUMN_LIMIT)),
		total: body.length,
		columns: Math.min(totalColumns, CSV_COLUMN_LIMIT),
		totalColumns,
	};
}

export type SortDirection = "ascending" | "descending";

/** True when the column has a value and every value in it reads as a number. */
function isNumeric(rows: string[][], column: number): boolean {
	let seen = false;
	for (const row of rows) {
		const cell = (row[column] ?? "").trim();
		if (cell === "") continue;
		if (!Number.isFinite(Number(cell))) return false;
		seen = true;
	}
	return seen;
}

/**
 * The row indexes in the order a sorted view shows them. The rows themselves
 * are never moved or changed. Empty cells go last either way, and equal cells
 * keep their file order.
 */
export function sortedOrder(
	rows: string[][],
	column: number,
	direction: SortDirection,
): number[] {
	const order = rows.map((_, at) => at);
	const numeric = isNumeric(rows, column);
	const sign = direction === "ascending" ? 1 : -1;
	const cell = (at: number) => (rows[at]?.[column] ?? "").trim();
	return order.sort((a, b) => {
		const left = cell(a);
		const right = cell(b);
		if (left === "" || right === "") {
			return left === right ? a - b : left === "" ? 1 : -1;
		}
		const by = numeric
			? Number(left) - Number(right)
			: left.localeCompare(right, undefined, { numeric: true });
		return by === 0 ? a - b : by * sign;
	});
}
