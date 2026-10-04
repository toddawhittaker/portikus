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

/** Hand text to the browser as a downloaded file; nothing keeps a copy. */
export function downloadText(fileName: string, text: string): void {
	const url = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
	const link = document.createElement("a");
	link.href = url;
	link.download = fileName;
	document.body.append(link);
	link.click();
	link.remove();
	// Revoked once the browser has started the download, not before.
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}
