import { describe, expect, test } from "vitest";
import { CsvError, parseCsv } from "./csv.js";

describe("parseCsv", () => {
	test("reads plain fields and LF line ends", () => {
		expect(parseCsv("a,b\nc,d\n")).toEqual([
			["a", "b"],
			["c", "d"],
		]);
	});

	test("reads CRLF line ends and a last line without one", () => {
		expect(parseCsv("a,b\r\nc,d")).toEqual([
			["a", "b"],
			["c", "d"],
		]);
	});

	test("keeps commas, doubled quotes and line breaks inside quotes", () => {
		expect(parseCsv('"Lee, Ann","say ""hi""","two\r\nlines"\n')).toEqual([
			["Lee, Ann", 'say "hi"', "two\r\nlines"],
		]);
	});

	test("drops a byte order mark and blank lines", () => {
		expect(parseCsv("﻿a,b\n\n\r\nc,d\n")).toEqual([
			["a", "b"],
			["c", "d"],
		]);
	});

	test("keeps empty fields", () => {
		expect(parseCsv(",x,\n")).toEqual([["", "x", ""]]);
	});

	test("refuses an unclosed quote and text after a closing quote", () => {
		expect(() => parseCsv('"open\n')).toThrow(CsvError);
		expect(() => parseCsv('"a"b,c\n')).toThrow(CsvError);
	});
});
