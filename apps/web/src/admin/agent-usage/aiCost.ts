import type { AiUsageCounts, ModelPrice } from "@portikus/contracts";

const PER_MILLION = 1_000_000;

/**
 * Dollars for the input side of a row: new input at the model's input price,
 * cache reads and writes at their ratios of it. Null when no price row
 * matches the model. The price table holds no output price, so output
 * tokens are not priced. The row whose model text is the longest match wins,
 * so "opus-5-5" beats "opus-5".
 */
export function estimateInputCost(
	row: AiUsageCounts & { model: string },
	prices: readonly ModelPrice[],
): number | null {
	let best: ModelPrice | null = null;
	for (const price of prices) {
		if (!row.model.includes(price.model)) continue;
		if (best === null || price.model.length > best.model.length) best = price;
	}
	if (best === null) return null;
	const weighted =
		row.inputTokens +
		row.cacheReadTokens * best.cacheReadRatio +
		row.cacheWriteTokens * best.cacheWriteRatio;
	return (weighted * best.inputPricePerMillion) / PER_MILLION;
}
