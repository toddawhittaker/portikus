import { expect, test } from "vitest";
import {
	draftOf,
	lifetime,
	listedHosts,
	parseDraft,
	ratio,
	runFailures,
	surcharge,
	unlistedSourceHosts,
} from "./text.js";

test("a moved page names the new host and address, and offers the Sources link", () => {
	const to = "https://platform.claude.com/docs/en/about-claude/pricing";
	const [moved] = runFailures(`docs.claude.com:moved=${encodeURIComponent(to)}`);
	expect(moved?.code).toBe("moved");
	expect(moved?.proxy).toBe(true);
	expect(moved?.text).toBe(
		`The page moved to platform.claude.com, which the server proxy does not allow. Change this source to ${to}, or allow platform.claude.com.`,
	);
	const [cut] = runFailures("docs.claude.com:moved=https%3A%2F%2Fplatform.cla%");
	expect(cut?.text).toMatch(/^The page moved to an address/);
});

test("each failed source gets its own plain sentence, and refused or unreachable point at the proxy offer", () => {
	const failures = runFailures(
		"a.example.com:refused,b.example.com:unreachable,c.example.com:too-large,d.example.com:bad-redirect,e.example.com:timeout,f.example.com:unknown-provider,g.example.com:no-rows,h.example.com:model-failed",
	);
	expect(failures.map((f) => f.host)).toEqual([
		"a.example.com",
		"b.example.com",
		"c.example.com",
		"d.example.com",
		"e.example.com",
		"f.example.com",
		"g.example.com",
		"h.example.com",
	]);
	expect(failures.map((f) => f.proxy)).toEqual([
		true,
		true,
		false,
		false,
		false,
		false,
		false,
		false,
	]);
	expect(new Set(failures.map((f) => f.text)).size).toBe(8);
	expect(failures[0]?.text).toMatch(/refused/);
});

test("a whole-run failure and an unknown code still read as sentences", () => {
	expect(runFailures(null)).toEqual([]);
	expect(runFailures("interrupted")[0]).toMatchObject({ host: null, proxy: false });
	expect(runFailures("interrupted")[0]?.text).toMatch(/restarted/);
	expect(runFailures("internal")[0]?.text).toMatch(/internal/);
	expect(runFailures("odd")[0]?.text).toMatch(/failed/);
	expect(runFailures("x.example.com:new-code")[0]?.text).toMatch(/could not read/);
});

test("the proxy offer names only hosts the server proxy lists on neither list, port 443 or none", () => {
	const listed = listedHosts([
		["Docs.Claude.com"],
		["developers.openai.com:443", "other.example.com:8443"],
	]);
	expect(
		unlistedSourceHosts(
			[
				"https://docs.claude.com/pricing",
				"https://developers.openai.com/api/docs/pricing",
				"https://other.example.com/p",
				"https://other.example.com/q",
			],
			listed,
		),
	).toEqual(["other.example.com"]);
	// Without the lists (no site jobs on this server) nothing is offered.
	expect(unlistedSourceHosts(["https://other.example.com/p"], null)).toEqual([]);
});

test("figures read as people write them", () => {
	expect(ratio(0.1)).toBe("0.1×");
	expect(ratio(null)).toBe("None");
	expect(lifetime(300)).toBe("5 min");
	expect(lifetime(3600)).toBe("1 h");
	expect(lifetime(45)).toBe("45 s");
	expect(surcharge({ surchargeAboveTokens: null, surchargeFactor: null })).toBe("None");
	expect(surcharge({ surchargeAboveTokens: 200_000, surchargeFactor: 2 })).toBe(
		"2× past 200,000 tokens",
	);
});

const GOOD = {
	...draftOf(null),
	model: "opus-5-5",
	inputPricePerMillion: "$5.00",
	cacheReadRatio: "0.1",
	cacheWriteRatio: "1.25",
	sourceUrl: "https://docs.claude.com/pricing",
	sourceQuote: "Opus: $5 / MTok",
};

test("a complete draft parses as the contract's row, with empty optional fields as null", () => {
	const parsed = parseDraft(GOOD);
	expect(parsed).toEqual({
		row: {
			provider: "anthropic",
			model: "opus-5-5",
			inputPricePerMillion: 5,
			cacheReadRatio: 0.1,
			cacheWriteRatio: 1.25,
			cacheWriteOneHourRatio: null,
			cacheTtlSeconds: 300,
			surchargeAboveTokens: null,
			surchargeFactor: null,
			sourceUrl: "https://docs.claude.com/pricing",
			sourceQuote: "Opus: $5 / MTok",
		},
	});
});

test("the contract's limits come back as one message per field", () => {
	const parsed = parseDraft({
		...GOOD,
		model: " ",
		cacheReadRatio: "1.5",
		cacheTtlSeconds: "2.5",
		sourceUrl: "http://10.0.0.1/p",
	});
	expect("errors" in parsed && Object.keys(parsed.errors).sort()).toEqual([
		"cacheReadRatio",
		"cacheTtlSeconds",
		"model",
		"sourceUrl",
	]);
});

test("a surcharge needs both figures, and the empty one is marked", () => {
	const parsed = parseDraft({ ...GOOD, surchargeFactor: "2" });
	expect("errors" in parsed && parsed.errors).toEqual({
		surchargeAboveTokens: "Give both surcharge figures, or leave both empty.",
	});
});

test("an edited row starts from its saved figures", () => {
	const draft = draftOf({
		id: "00000000-0000-4000-8000-000000000001",
		provider: "openai",
		model: "gpt-7",
		inputPricePerMillion: 2,
		cacheReadRatio: 0.1,
		cacheWriteRatio: 1.25,
		cacheWriteOneHourRatio: null,
		cacheTtlSeconds: 600,
		surchargeAboveTokens: 272_000,
		surchargeFactor: 2,
		sourceUrl: "https://developers.openai.com/api/docs/pricing",
		sourceQuote: "q",
		checkedAt: "2026-11-10T00:00:00.000Z",
		updatedAt: "2026-11-10T00:00:00.000Z",
	});
	expect(draft).toMatchObject({
		provider: "openai",
		inputPricePerMillion: "2",
		cacheWriteOneHourRatio: "",
		cacheTtlSeconds: "600",
		surchargeAboveTokens: "272000",
	});
});
