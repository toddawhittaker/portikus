/** What the price check model submits is checked before it is stored (SPEC.md section 20.4). */
import { describe, expect, test } from "vitest";
import { checkRows, providerOfSource } from "./validate.js";

const SOURCE = {
	url: "https://developers.openai.com/api/docs/pricing",
	provider: "openai" as const,
	text: "GPT Test: input $2.00 per million tokens, cached $0.20",
};

const ROW = {
	provider: "openai",
	model: "gpt-test",
	inputPricePerMillion: 2,
	outputPricePerMillion: 10,
	cacheReadRatio: 0.1,
	cacheWriteRatio: 1.25,
	cacheWriteOneHourRatio: null,
	cacheTtlSeconds: 300,
	surchargeAboveTokens: null,
	surchargeFactor: null,
	sourceUrl: "https://evil.example.com/",
	sourceQuote: "GPT Test: input $2.00   per million tokens",
};

describe("providerOfSource", () => {
	test("names the provider from the host", () => {
		expect(providerOfSource("https://docs.claude.com/x")).toBe("anthropic");
		expect(providerOfSource("https://www.anthropic.com/pricing")).toBe("anthropic");
		expect(providerOfSource("https://openai.com/api/pricing")).toBe("openai");
		expect(providerOfSource("https://notopenai.com/")).toBeNull();
	});
});

describe("checkRows", () => {
	test("an Anthropic model name is stored as its API id", () => {
		const out = checkRows(
			{
				rows: [
					{
						...ROW,
						provider: "anthropic",
						model: "Claude Opus 5.5",
						sourceQuote: "GPT Test: input $2.00 per million tokens",
					},
				],
			},
			{ ...SOURCE, provider: "anthropic" },
		);
		expect(out.errors).toEqual([]);
		expect(out.rows[0]?.model).toBe("claude-opus-5-5");
	});

	test("keeps a good row, with the page fetched as its address", () => {
		const out = checkRows({ rows: [ROW] }, SOURCE);
		expect(out.errors).toEqual([]);
		expect(out.rows[0]?.sourceUrl).toBe(SOURCE.url);
		expect(out.rows[0]?.sourceQuote).toBe("GPT Test: input $2.00 per million tokens");
	});

	test("refuses a quote that is not on the page", () => {
		const out = checkRows({ rows: [{ ...ROW, sourceQuote: "input $0.01" }] }, SOURCE);
		expect(out.rows).toEqual([]);
		expect(out.errors[0]).toMatch(/sourceQuote/);
	});

	test("refuses another provider's row, a cache read above input, and half a surcharge", () => {
		const out = checkRows(
			{
				rows: [
					{ ...ROW, provider: "anthropic" },
					{ ...ROW, cacheReadRatio: 1.5 },
					{ ...ROW, surchargeAboveTokens: 200_000 },
				],
			},
			SOURCE,
		);
		expect(out.rows).toEqual([]);
		expect(out.errors).toHaveLength(3);
	});

	test("refuses input that is not { rows }", () => {
		expect(checkRows("nope", SOURCE).errors).toHaveLength(1);
		expect(checkRows({ rows: [] }, SOURCE).errors).toHaveLength(1);
		expect(checkRows({ rows: [42] }, SOURCE).errors).toHaveLength(1);
	});

	test("errors never quote the page or the input", () => {
		const out = checkRows(
			{ rows: [{ ...ROW, model: "", sourceQuote: "secret words" }] },
			SOURCE,
		);
		expect(out.errors.join(" ")).not.toContain("secret words");
	});
});
