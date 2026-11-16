import type { ModelPrice } from "@portikus/contracts";
import { afterEach, expect, test, vi } from "vitest";
import { loadPriceTable, priceRatios, resetPriceTable } from "./restartEstimate.js";

/** The student estimate prefers the site's price table and falls back to the built-in one (SPEC.md §10.8). */

function row(overrides: Partial<ModelPrice>): ModelPrice {
	return {
		provider: "anthropic",
		model: "opus-5-5",
		inputPricePerMillion: 5,
		cacheReadRatio: 0.2,
		cacheWriteRatio: 1.5,
		cacheWriteOneHourRatio: 3,
		cacheTtlSeconds: 300,
		surchargeAboveTokens: null,
		surchargeFactor: null,
		sourceUrl: "https://platform.claude.com/docs/en/about-claude/pricing",
		sourceQuote: "Opus: $5 per million input tokens",
		checkedAt: "2026-11-10T00:00:00.000Z",
		updatedAt: "2026-11-10T00:00:00.000Z",
		...overrides,
	};
}

function serve(body: unknown, ok = true) {
	const fetch = vi.fn(
		async () => new Response(JSON.stringify(body), { status: ok ? 200 : 500 }),
	);
	vi.stubGlobal("fetch", fetch);
	return fetch;
}

afterEach(() => {
	resetPriceTable();
	vi.unstubAllGlobals();
});

test("the site row for exactly the model id sets the ratios", async () => {
	serve({
		prices: [
			row({}),
			row({ model: "claude-opus-5-5", cacheReadRatio: 0.3 }),
			row({ provider: "openai", model: "claude-opus-5-5", cacheReadRatio: 0.9 }),
		],
	});
	await loadPriceTable();
	// Only the agent's own provider counts.
	expect(priceRatios("claude", "claude-opus-5-5", 300)).toEqual({
		read: 0.3,
		write: 1.5,
		surcharge: null,
	});
	expect(priceRatios("claude", "claude-opus-5-5", 3600).write).toBe(3);
});

test("a one-hour cache without a one-hour ratio uses the plain write ratio", async () => {
	serve({
		prices: [
			row({
				provider: "openai",
				model: "gpt-7",
				cacheWriteOneHourRatio: null,
				surchargeAboveTokens: 400_000,
				surchargeFactor: 2,
			}),
		],
	});
	await loadPriceTable();
	expect(priceRatios("codex", "gpt-7", 3600)).toEqual({
		read: 0.2,
		write: 1.5,
		surcharge: { above: 400_000, factor: 2 },
	});
});

test("a model with no site row uses the built-in table", async () => {
	serve({ prices: [row({ model: "sonnet-5-5" })] });
	await loadPriceTable();
	expect(priceRatios("claude", "claude-opus-5-5", 300).read).toBe(0.05);
});

test("a failed read falls back silently, and the table is asked for once", async () => {
	const fetch = serve({ error: "nope" }, false);
	await loadPriceTable();
	expect(priceRatios("claude", "claude-opus-5-5", 300).read).toBe(0.05);
	await loadPriceTable();
	expect(fetch).toHaveBeenCalledTimes(1);
});

test("a dated release matches its model's row; a longer or shorter model id never does", async () => {
	serve({
		prices: [
			row({ model: "claude-opus-5", cacheReadRatio: 0.4 }),
			row({ model: "claude-opus-5-5", cacheReadRatio: 0.3 }),
			row({ provider: "openai", model: "gpt-5", cacheReadRatio: 0.6 }),
		],
	});
	await loadPriceTable();
	expect(priceRatios("claude", "claude-opus-5-5-20261101", 300).read).toBe(0.3);
	expect(priceRatios("claude", "claude-opus-5-5", 300).read).toBe(0.3);
	expect(priceRatios("claude", "claude-opus-5", 300).read).toBe(0.4);
	expect(priceRatios("codex", "gpt-5", 300).read).toBe(0.6);
	// gpt-5-mini is a different model from gpt-5, so the built-in table answers.
	expect(priceRatios("codex", "gpt-5-mini", 300).read).not.toBe(0.6);
	expect(priceRatios("codex", "gpt-5-2026", 300).read).not.toBe(0.6);
});
