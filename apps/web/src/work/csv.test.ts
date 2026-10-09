import { CsvError } from "@portikus/contracts";
import { describe, expect, test } from "vitest";
import { CSV_COLUMN_LIMIT, CSV_ROW_LIMIT, csvTable } from "./csv.js";

describe("csvTable", () => {
	test("reads the first record as the header and counts the rest", () => {
		expect(csvTable("name,score\nAnn,9\nBo,7\n")).toEqual({
			header: ["name", "score"],
			rows: [
				["Ann", "9"],
				["Bo", "7"],
			],
			total: 2,
			columns: 2,
			totalColumns: 2,
		});
	});

	test("an empty file has no table", () => {
		expect(csvTable("")).toBeNull();
		expect(csvTable("\n\n")).toBeNull();
	});

	test("the widest drawn record sets the column count", () => {
		expect(csvTable("a\n1,2,3\n4\n")?.columns).toBe(3);
	});

	test("a file that is not valid CSV throws for the view to explain", () => {
		expect(() => csvTable('a\n"open\n')).toThrow(CsvError);
	});

	test("draws at most the limit but counts every row", () => {
		const text = ["n", ...Array.from({ length: CSV_ROW_LIMIT + 5 }, (_, i) => i)].join(
			"\n",
		);
		const table = csvTable(text);
		expect(table?.rows).toHaveLength(CSV_ROW_LIMIT);
		expect(table?.total).toBe(CSV_ROW_LIMIT + 5);
	});

	test("draws at most the column limit but counts every column", () => {
		const wide = Array.from({ length: CSV_COLUMN_LIMIT + 50 }, (_, i) => i).join(",");
		const table = csvTable(`a\n${wide}\n`);
		expect(table?.columns).toBe(CSV_COLUMN_LIMIT);
		expect(table?.totalColumns).toBe(CSV_COLUMN_LIMIT + 50);
		expect(table?.rows[0]).toHaveLength(CSV_COLUMN_LIMIT);
	});

	test("a header of a million commas is cut to the column limit", () => {
		const table = csvTable(",".repeat(1_000_000));
		expect(table?.header).toHaveLength(CSV_COLUMN_LIMIT);
		expect(table?.totalColumns).toBe(1_000_001);
	});
});
