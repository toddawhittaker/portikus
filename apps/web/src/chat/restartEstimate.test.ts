import { describe, expect, test } from "vitest";
import {
	bestRestart,
	estimateRestart,
	FALLBACK_GROWTH,
	FALLBACK_REQUESTS,
	HANDOFF_TOKENS,
	messageCost,
	type PriceRatios,
	priceRatios,
} from "./restartEstimate.js";

const ONE_HOUR: PriceRatios = { read: 0.05, write: 2, surcharge: null };
const FIVE_MINUTES: PriceRatios = { read: 0.05, write: 1.25, surcharge: null };
const GPT: PriceRatios = {
	read: 0.1,
	write: 1.25,
	surcharge: { above: 272_000, factor: 2 },
};

test("the reference values", () => {
	expect(bestRestart(66_000, 18_000, 14, 1_000_000, ONE_HOUR)).toEqual({
		bestRun: 5,
		restartAt: 156_000,
	});
	expect(bestRestart(66_000, 18_000, 14, 1_000_000, FIVE_MINUTES)).toEqual({
		bestRun: 4,
		restartAt: 138_000,
	});
	// Codex at read 0.1 and write 1.25 (it was 0.05 and 1: 4 messages, 56,000).
	expect(bestRestart(24_000, 8000, 6, 475_000, GPT)).toEqual({
		bestRun: 3,
		restartAt: 48_000,
	});
});

test("price ratios by agent, model and cache length", () => {
	expect(priceRatios("claude", "claude-opus-5-5", 3600)).toEqual(ONE_HOUR);
	expect(priceRatios("claude", "claude-sonnet-5-5", 300)).toEqual(FIVE_MINUTES);
	expect(priceRatios("claude", "claude-fable-5", 300).read).toBe(0.025);
	expect(priceRatios("claude", "claude-mythos-5", null).read).toBe(0.025);
	expect(priceRatios("claude", "claude-other", null)).toEqual({
		read: 0.1,
		write: 1.25,
		surcharge: null,
	});
	expect(priceRatios("claude", "claude-haiku-5-5", 300).surcharge).toEqual({
		above: 100_000,
		factor: 5,
	});
	expect(priceRatios("codex", "gpt-6.1-codex", null)).toEqual(GPT);
	expect(priceRatios("codex", "gpt-5.6", 1800)).toEqual({
		read: 0.1,
		write: 1.25,
		surcharge: null,
	});
});

test("the surcharge applies once the message's context passes the threshold", () => {
	const haiku = priceRatios("claude", "claude-haiku-5-5", 300);
	const plain = { ...haiku, surcharge: null };
	// 82,000 + 18,000 is exactly 100,000: not past it.
	expect(messageCost(82_000, false, 18_000, 14, haiku)).toBe(
		messageCost(82_000, false, 18_000, 14, plain),
	);
	expect(messageCost(82_001, false, 18_000, 14, haiku)).toBeCloseTo(
		5 * messageCost(82_001, false, 18_000, 14, plain),
	);
	expect(messageCost(265_000, true, 8000, 6, GPT)).toBeCloseTo(
		2 * messageCost(265_000, true, 8000, 6, { ...GPT, surcharge: null }),
	);
});

test("a cold first request is priced as a cache write", () => {
	const warm = messageCost(50_000, false, 10_000, 1, ONE_HOUR);
	const cold = messageCost(50_000, true, 10_000, 1, ONE_HOUR);
	expect(cold - warm).toBeCloseTo((2 - 0.05) * 50_000);
});

test("the fallbacks stand until two messages are seen, then the observed rates", () => {
	const base = {
		usedTokens: 100_000,
		windowTokens: 1_000_000,
		firstUsedTokens: 58_000,
		contextEvents: 1,
		prices: ONE_HOUR,
	};
	// Fallbacks reproduce the first reference: S = 66,000, C* = 156,000.
	const early = estimateRestart({ ...base, messagesSent: 1 });
	expect(early.restartAt).toBe(156_000);
	expect(early.messagesLeft).toBe(Math.floor((156_000 - 100_000) / FALLBACK_GROWTH));
	expect(FALLBACK_REQUESTS).toBe(14);
	expect(HANDOFF_TOKENS).toBe(8000);

	// Observed: g = (94,000 - 58,000) / 2 = 18,000; q = 28 / 2 = 14.
	const observed = estimateRestart({
		...base,
		usedTokens: 94_000,
		messagesSent: 2,
		contextEvents: 28,
	});
	expect(observed).toEqual({ messagesLeft: 3, restartAt: 156_000, bestRun: 5 });
});

test("growth is floored at 1000 and requests at 1", () => {
	const flat = estimateRestart({
		usedTokens: 50_000,
		windowTokens: 1_000_000,
		firstUsedTokens: 50_000,
		messagesSent: 4,
		contextEvents: 0,
		prices: ONE_HOUR,
	});
	// With g = 1000, the restart size and messages left step in thousands.
	expect((flat.restartAt - 58_000) % 1000).toBe(0);
	expect(flat.restartAt).toBe(58_000 + flat.bestRun * 1000);
	expect(flat.messagesLeft).toBe(Math.floor((flat.restartAt - 50_000) / 1000));
	// q = 1 means one request per message: no warm re-reads.
	expect(messageCost(10_000, true, 1000, 1, ONE_HOUR)).toBe(2 * 10_000 + 2 * 1000);
});

test("the run is capped at 90% of the window, and at least one message", () => {
	// Cheapest run is 5 here, but only 2 fit: 66,000 + 2 x 18,000 <= 108,000.
	expect(bestRestart(66_000, 18_000, 14, 120_000, ONE_HOUR)).toEqual({
		bestRun: 2,
		restartAt: 102_000,
	});
	expect(bestRestart(66_000, 18_000, 14, 50_000, ONE_HOUR).bestRun).toBe(1);
});

test("messages left is never negative", () => {
	const late = estimateRestart({
		usedTokens: 900_000,
		windowTokens: 1_000_000,
		firstUsedTokens: 58_000,
		messagesSent: 1,
		contextEvents: 14,
		prices: ONE_HOUR,
	});
	expect(late.messagesLeft).toBe(0);
});

describe("a cold cache", () => {
	// Used 300k, a fresh chat starting at S = 48k + 8k = 56k, read 0.05, write 2.
	const inputs = {
		usedTokens: 300_000,
		windowTokens: 1_000_000,
		firstUsedTokens: 48_000,
		messagesSent: 1,
		contextEvents: 14,
		prices: ONE_HOUR,
	};

	test("prices the next message here as a re-write, so a fresh chat saves usage now", () => {
		// Extra here: 1.95 x 300k = 585k; extra in a fresh chat: 1.95 x 56k = 109.2k.
		expect(estimateRestart({ ...inputs, cold: true }).messagesLeft).toBe(0);
	});

	test("a warm or unknown cache keeps the renewal estimate", () => {
		const small = { ...inputs, usedTokens: 56_000 };
		const warm = estimateRestart(small);
		expect(warm.messagesLeft).toBeGreaterThan(0);
		// At the fresh chat's own size, a cold write costs the same either way.
		expect(estimateRestart({ ...small, cold: true })).toEqual(warm);
		expect(estimateRestart({ ...small, cold: false })).toEqual(warm);
	});
});
