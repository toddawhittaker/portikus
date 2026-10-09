/** A CSV file read for the file tab's table view (SPEC.md §13.2). */
import { parseCsv } from "@portikus/contracts";

/** At most this many rows under the header are drawn, so a large file stays quick. */
export const CSV_ROW_LIMIT = 1000;

/** At most this many columns are drawn, so a line of a million commas cannot hang the tab. */
export const CSV_COLUMN_LIMIT = 200;

export interface CsvTable {
	/** The first record, read as the column names. */
	header: string[];
	/** The records under the header, at most the limit. */
	rows: string[][];
	/** How many records sit under the header in the whole file. */
	total: number;
	/** How many columns are drawn: the widest drawn record, at most the column limit. */
	columns: number;
	/** The widest drawn record's field count, before the column limit. */
	totalColumns: number;
}

/**
 * The file as a header and its first rows; null when it holds no records.
 * Throws CsvError when the file is not valid CSV.
 */
export function csvTable(text: string, limit = CSV_ROW_LIMIT): CsvTable | null {
	const [header, ...body] = parseCsv(text);
	if (header === undefined) return null;
	const drawn = body.slice(0, limit);
	let totalColumns = header.length;
	for (const row of drawn) totalColumns = Math.max(totalColumns, row.length);
	return {
		header: header.slice(0, CSV_COLUMN_LIMIT),
		rows: drawn.map((row) => row.slice(0, CSV_COLUMN_LIMIT)),
		total: body.length,
		columns: Math.min(totalColumns, CSV_COLUMN_LIMIT),
		totalColumns,
	};
}
