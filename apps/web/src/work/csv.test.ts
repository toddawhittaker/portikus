import { CsvError } from "@portikus/contracts";
import { describe, expect, test } from "vitest";
import { CSV_ROW_LIMIT, csvTable } from "./csv.js";

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
});
