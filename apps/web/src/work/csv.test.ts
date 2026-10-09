import { CsvError } from "@portikus/contracts";
import { describe, expect, test } from "vitest";
import { CSV_COLUMN_LIMIT, CSV_ROW_LIMIT, csvTable, sortedOrder } from "./csv.js";

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

	test("keeps every row so the view can sort the whole file", () => {
		const text = ["n", ...Array.from({ length: CSV_ROW_LIMIT + 5 }, (_, i) => i)].join(
			"\n",
		);
		const table = csvTable(text);
		expect(table?.rows).toHaveLength(CSV_ROW_LIMIT + 5);
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

describe("sortedOrder", () => {
	const col = (...cells: string[]) => cells.map((cell) => [cell]);

	test("a column of numbers sorts by value, not by text", () => {
		const rows = col("10", "9", "2.5");
		expect(sortedOrder(rows, 0, "ascending")).toEqual([2, 1, 0]);
		expect(sortedOrder(rows, 0, "descending")).toEqual([0, 1, 2]);
	});

	test("a column with any non-number sorts as text, digits in natural order", () => {
		const rows = col("item 10", "item 9", "Apple");
		expect(sortedOrder(rows, 0, "ascending")).toEqual([2, 1, 0]);
	});

	test("empty cells go last in both directions and do not stop a number column", () => {
		const rows = col("3", "", "1");
		expect(sortedOrder(rows, 0, "ascending")).toEqual([2, 0, 1]);
		expect(sortedOrder(rows, 0, "descending")).toEqual([0, 2, 1]);
	});

	test("equal cells keep their file order, either direction", () => {
		const rows = col("b", "a", "b", "a");
		expect(sortedOrder(rows, 0, "ascending")).toEqual([1, 3, 0, 2]);
		expect(sortedOrder(rows, 0, "descending")).toEqual([0, 2, 1, 3]);
	});

	test("a short row counts as empty and the rows are not changed", () => {
		const rows = [["x", "2"], ["y"], ["z", "1"]];
		const before = JSON.stringify(rows);
		expect(sortedOrder(rows, 1, "ascending")).toEqual([2, 0, 1]);
		expect(JSON.stringify(rows)).toBe(before);
	});
});
