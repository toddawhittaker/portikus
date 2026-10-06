import {
	ACCOUNT_IMPORT_COLUMNS,
	type AccountImportResultRow,
} from "@portikus/contracts";

/** The file the import dialog offers as a starting point (SPEC.md section 5.1). */
export const SAMPLE_IMPORT_CSV = [
	ACCOUNT_IMPORT_COLUMNS.join(","),
	"Ada Lovelace,ada@example.edu,ada,student,password",
	'"Hopper, Grace",grace@example.edu,,instructor,invite',
	"Alan Turing,alan@example.edu,alan@contoso.onmicrosoft.com,student,invite",
	"",
].join("\r\n");

/** One CSV cell, quoted when needed. */
function cell(value: string): string {
	// A leading =, +, - or @ would run as a formula in a spreadsheet.
	const safe = /^[=+\-@]/.test(value) ? `'${value}` : value;
	return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

/** The one-time passwords of a confirmed import as a CSV file's text. */
export function passwordsCsv(rows: AccountImportResultRow[]): string {
	const lines = [["name", "username", "one-time password"]];
	for (const row of rows) {
		if (row.password) lines.push([row.name, row.username, row.password]);
	}
	return `${lines.map((line) => line.map(cell).join(",")).join("\r\n")}\r\n`;
}
