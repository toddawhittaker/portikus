import { ACCOUNT_IMPORT_MAX_ROWS } from "@portikus/contracts";
import { describe, expect, test } from "vitest";
import { ImportFileError, readImportFile } from "./account-import.js";

describe("readImportFile", () => {
	const header = "name,email,username,role,kind\n";

	test("accepts the columns in any order and any case", () => {
		const rows = readImportFile(
			"KIND, Role ,Email,Name,Username\ninvite,student,a@example.edu,Ann,\n",
		);
		expect(rows).toEqual([
			{
				line: 2,
				fieldCount: 5,
				name: "Ann",
				email: "a@example.edu",
				username: "",
				role: "student",
				kind: "invite",
			},
		]);
	});

	test("refuses a missing, repeated or unknown column", () => {
		expect(() => readImportFile("name,email,role,kind\nx,y,z,w\n")).toThrow(
			'The header has no "username" column.',
		);
		expect(() => readImportFile("name,name,email,username,role,kind\n")).toThrow(
			'"name" more than once',
		);
		expect(() => readImportFile("name,email,username,role,kind,age\n")).toThrow(
			'Unknown column "age"',
		);
	});

	test("refuses an empty file and a header with no rows", () => {
		expect(() => readImportFile("")).toThrow("The file is empty.");
		expect(() => readImportFile(header)).toThrow("no rows");
	});

	test("refuses more than the row limit and allows exactly it", () => {
		const line = "Ann,a@example.edu,ann,student,invite\n";
		expect(readImportFile(header + line.repeat(ACCOUNT_IMPORT_MAX_ROWS))).toHaveLength(
			ACCOUNT_IMPORT_MAX_ROWS,
		);
		expect(() =>
			readImportFile(header + line.repeat(ACCOUNT_IMPORT_MAX_ROWS + 1)),
		).toThrow(ImportFileError);
	});

	test("refuses a file over 256 KB", () => {
		expect(() => readImportFile(header + "x".repeat(256 * 1024))).toThrow("256 KB");
	});

	test("counts the fields of a short or long row", () => {
		const rows = readImportFile(
			`${header}Ann,a@example.edu\nB,b@x.edu,b,student,invite,extra\n`,
		);
		expect(rows.map((r) => r.fieldCount)).toEqual([2, 6]);
	});

	test("reports a malformed quote as a file error", () => {
		expect(() => readImportFile(`${header}"Ann,a\n`)).toThrow(ImportFileError);
	});
});
