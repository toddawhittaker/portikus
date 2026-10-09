/**
 * A small CSV reader (RFC 4180) for the account import and the file tab's
 * table view: quoted fields, doubled quotes, commas and line breaks inside
 * quotes, CRLF or LF line ends, and a leading byte order mark. No dependency
 * for one file format.
 */

export class CsvError extends Error {}

/** A quoted field starting after its opening quote: its text and where reading resumes. */
function readQuoted(input: string, start: number): { value: string; next: number } {
	let value = "";
	let i = start;
	while (i < input.length) {
		const ch = input[i];
		if (ch !== '"') {
			value += ch;
			i += 1;
		} else if (input[i + 1] === '"') {
			value += '"';
			i += 2;
		} else {
			const after = input[i + 1];
			if (after !== undefined && after !== "," && after !== "\r" && after !== "\n") {
				throw new CsvError("A quoted field must end at a comma or line end.");
			}
			return { value, next: i + 1 };
		}
	}
	throw new CsvError("A quoted field is never closed.");
}

/** Every record of the text as an array of fields; blank lines are dropped. */
export function parseCsv(text: string): string[][] {
	const input = text.startsWith("﻿") ? text.slice(1) : text;
	const records: string[][] = [];
	let record: string[] = [];
	let field = "";
	const endRecord = () => {
		record.push(field);
		field = "";
		// A line with nothing on it is not a record.
		if (!(record.length === 1 && record[0] === "")) records.push(record);
		record = [];
	};
	let i = 0;
	while (i < input.length) {
		const ch = input[i];
		if (ch === '"' && field === "") {
			const quoted = readQuoted(input, i + 1);
			field = quoted.value;
			i = quoted.next;
		} else if (ch === ",") {
			record.push(field);
			field = "";
			i += 1;
		} else if (ch === "\r" && input[i + 1] === "\n") {
			endRecord();
			i += 2;
		} else if (ch === "\n" || ch === "\r") {
			endRecord();
			i += 1;
		} else {
			field += ch;
			i += 1;
		}
	}
	if (field !== "" || record.length > 0) endRecord();
	return records;
}
