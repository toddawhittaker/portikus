import type { ModelPrice } from "@portikus/contracts";
import { expect, test } from "vitest";
import { estimateInputCost } from "./aiCost.js";

function price(model: string, inputPricePerMillion: number): ModelPrice {
	return {
		provider: "anthropic",
		model,
		inputPricePerMillion,
		cacheReadRatio: 0.1,
		cacheWriteRatio: 1.25,
		cacheWriteOneHourRatio: null,
		cacheTtlSeconds: 300,
		surchargeAboveTokens: null,
		surchargeFactor: null,
		sourceUrl: "https://example.com/pricing",
		sourceQuote: "quote",
		checkedAt: "2026-11-10T00:00:00.000Z",
		updatedAt: "2026-11-10T00:00:00.000Z",
	};
}

const COUNTS = {
	inputTokens: 1_000_000,
	outputTokens: 500_000,
	cacheReadTokens: 2_000_000,
	cacheWriteTokens: 800_000,
};

test("prices input, cache reads and cache writes at the matching row, and leaves output out", () => {
	// (1M + 2M * 0.1 + 0.8M * 1.25) = 2.2M input-equivalent tokens at $5 per million.
	expect(
		estimateInputCost({ ...COUNTS, model: "claude-opus-5-5" }, [price("opus-5-5", 5)]),
	).toBeCloseTo(11);
});

test("the longest matching model text wins", () => {
	const prices = [price("opus-5", 15), price("opus-5-5", 5)];
	expect(
		estimateInputCost({ ...COUNTS, model: "claude-opus-5-5" }, prices),
	).toBeCloseTo(11);
});

test("a model the table does not know has no estimate", () => {
	expect(
		estimateInputCost({ ...COUNTS, model: "mystery-1" }, [price("opus-5-5", 5)]),
	).toBeNull();
	expect(estimateInputCost({ ...COUNTS, model: "mystery-1" }, [])).toBeNull();
});
