/** A CSV file read for the file tab's table view (SPEC.md §13.2). */
import { parseCsv } from "@portikus/contracts";

/** At most this many rows under the header are drawn, so a large file stays quick. */
export const CSV_ROW_LIMIT = 1000;

export interface CsvTable {
	/** The first record, read as the column names. */
	header: string[];
	/** The records under the header, at most the limit. */
	rows: string[][];
	/** How many records sit under the header in the whole file. */
	total: number;
	/** The widest record's field count, so shorter records can be padded. */
	columns: number;
}

/**
 * The file as a header and its first rows; null when it holds no records.
 * Throws CsvError when the file is not valid CSV.
 */
export function csvTable(text: string, limit = CSV_ROW_LIMIT): CsvTable | null {
	const [header, ...body] = parseCsv(text);
	if (header === undefined) return null;
	const rows = body.slice(0, limit);
	let columns = header.length;
	for (const row of rows) columns = Math.max(columns, row.length);
	return { header, rows, total: body.length, columns };
}
