import { describe, expect, test } from "vitest";
import { PriceRowInput, PricingTable } from "./pricing.js";

const row = {
	provider: "anthropic",
	model: "opus-5-5",
	inputPricePerMillion: 5,
	cacheReadRatio: 0.05,
	cacheWriteRatio: 1.25,
	cacheWriteOneHourRatio: 2,
	cacheTtlSeconds: 300,
	surchargeAboveTokens: null,
	surchargeFactor: null,
	sourceUrl: "https://claude.com/pricing",
	sourceQuote: "Cache hits: $0.25 / MTok",
};

describe("PriceRowInput", () => {
	test("accepts a sourced row", () => {
		expect(PriceRowInput.parse(row)).toEqual(row);
	});

	test("refuses a cache read above the input price", () => {
		expect(PriceRowInput.safeParse({ ...row, cacheReadRatio: 1.5 }).success).toBe(
			false,
		);
	});

	test("refuses a row with no source", () => {
		expect(PriceRowInput.safeParse({ ...row, sourceQuote: "" }).success).toBe(false);
		expect(
			PriceRowInput.safeParse({ ...row, sourceUrl: "http://claude.com" }).success,
		).toBe(false);
	});

	test("refuses half a surcharge", () => {
		expect(
			PriceRowInput.safeParse({ ...row, surchargeAboveTokens: 100_000 }).success,
		).toBe(false);
		expect(
			PriceRowInput.safeParse({
				...row,
				surchargeAboveTokens: 100_000,
				surchargeFactor: 5,
			}).success,
		).toBe(true);
	});
});

test("the public table is a list of dated rows", () => {
	const at = "2026-11-15T00:00:00.000Z";
	expect(
		PricingTable.parse({ prices: [{ ...row, checkedAt: at, updatedAt: at }] }).prices,
	).toHaveLength(1);
});
