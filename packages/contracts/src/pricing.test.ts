import { describe, expect, test } from "vitest";
import {
	normalizePriceModel,
	normalizePriceRow,
	PriceProposalDecision,
	PriceRowInput,
	PricingTable,
	priceRowFor,
	usageDollars,
} from "./pricing.js";

const row = {
	provider: "anthropic",
	model: "opus-5-5",
	inputPricePerMillion: 5,
	outputPricePerMillion: 25,
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

test("every save names an output price, and a stored row may lack one", () => {
	const { outputPricePerMillion: _, ...noOutput } = row;
	expect(PriceRowInput.safeParse(noOutput).success).toBe(false);
	expect(PriceRowInput.safeParse({ ...row, outputPricePerMillion: null }).success).toBe(
		false,
	);
	expect(PriceRowInput.safeParse({ ...row, outputPricePerMillion: 0 }).success).toBe(
		false,
	);
	const at = "2026-11-15T00:00:00.000Z";
	expect(
		PricingTable.safeParse({ prices: [{ ...noOutput, checkedAt: at, updatedAt: at }] })
			.success,
	).toBe(true);
	expect(
		PricingTable.safeParse({
			prices: [{ ...row, outputPricePerMillion: null, checkedAt: at, updatedAt: at }],
		}).success,
	).toBe(true);
});

describe("priceRowFor", () => {
	const rows = [
		{ provider: "anthropic" as const, model: "claude-opus-5-5" },
		{ provider: "openai" as const, model: "gpt-6.1" },
	];

	test("finds the row whose normalised name equals the model's", () => {
		expect(priceRowFor("Claude Opus 5.5", rows)).toBe(rows[0]);
		expect(priceRowFor(" GPT-6.1 ", rows)).toBe(rows[1]);
	});

	test("a name that only contains a row's name matches nothing", () => {
		expect(priceRowFor("claude-opus-5-5-20261101", rows)).toBeUndefined();
		expect(priceRowFor("gpt-6.1-mini", rows)).toBeUndefined();
		expect(priceRowFor("gpt-6", rows)).toBeUndefined();
	});
});

describe("usageDollars", () => {
	const none = {
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
	};

	test("prices plain input and output per million", () => {
		expect(
			usageDollars({ ...none, inputTokens: 1_000_000, outputTokens: 1_000_000 }, row),
		).toBeCloseTo(30);
	});

	test("cache reads and writes are taken out of input and priced by their ratios", () => {
		// 1,000,000 input of which 600,000 read and 200,000 written: 200,000 plain.
		const dollars = usageDollars(
			{
				inputTokens: 1_000_000,
				outputTokens: 0,
				cacheReadTokens: 600_000,
				cacheWriteTokens: 200_000,
			},
			row,
		);
		expect(dollars).toBeCloseTo(0.2 * 5 + 0.6 * 5 * 0.05 + 0.2 * 5 * 1.25);
	});

	test("cached counts above the input total never price below zero", () => {
		expect(
			usageDollars({ ...none, inputTokens: 10, cacheReadTokens: 20 }, row),
		).toBeCloseTo((20 * 5 * 0.05) / 1_000_000);
	});

	test("no output price means no estimate", () => {
		expect(usageDollars(none, { ...row, outputPricePerMillion: null })).toBeNull();
		const { outputPricePerMillion: _, ...noOutput } = row;
		expect(usageDollars(none, noOutput)).toBeNull();
	});
});

describe("PriceProposalDecision", () => {
	test("takes an optional output price, above zero and within the cap", () => {
		expect(PriceProposalDecision.safeParse({ decision: "accept" }).success).toBe(true);
		expect(
			PriceProposalDecision.parse({ decision: "accept", outputPricePerMillion: 12.5 })
				.outputPricePerMillion,
		).toBe(12.5);
		for (const bad of [0, -1, 10_001, null]) {
			expect(
				PriceProposalDecision.safeParse({
					decision: "accept",
					outputPricePerMillion: bad,
				}).success,
			).toBe(false);
		}
		expect(
			PriceProposalDecision.safeParse({ decision: "accept", extra: 1 }).success,
		).toBe(false);
	});
});
