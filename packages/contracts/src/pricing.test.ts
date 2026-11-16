import { describe, expect, test } from "vitest";
import {
	normalizePriceModel,
	normalizePriceRow,
	PriceRowInput,
	PricingTable,
} from "./pricing.js";

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

describe("normalizePriceModel", () => {
	test("an Anthropic name becomes its API id", () => {
		expect(normalizePriceModel("anthropic", "Claude Opus 5.5")).toBe("claude-opus-5-5");
		expect(normalizePriceModel("anthropic", "Claude Haiku 4.5")).toBe(
			"claude-haiku-4-5",
		);
		expect(normalizePriceModel("anthropic", "  claude  opus..5.5 ")).toBe(
			"claude-opus-5-5",
		);
		expect(normalizePriceModel("anthropic", "claude-opus-5-5")).toBe("claude-opus-5-5");
	});

	test("an OpenAI name is only lowercased and trimmed", () => {
		expect(normalizePriceModel("openai", " GPT-6.1 Sol ")).toBe("gpt-6.1 sol");
	});

	test("a row keeps its other figures", () => {
		expect(
			normalizePriceRow(PriceRowInput.parse({ ...row, model: "Claude Opus 5.5" })),
		).toEqual({
			...row,
			model: "claude-opus-5-5",
		});
	});
});
