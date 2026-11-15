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
	read: 0.05,
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
	// GPT-6.1 at API prices: read 0.05 and write 1.25.
	expect(bestRestart(24_000, 8000, 6, 475_000, GPT)).toEqual({
		bestRun: 5,
		restartAt: 64_000,
	});
	// An older Codex model reads at 0.1.
	expect(
		bestRestart(24_000, 8000, 6, 475_000, { ...GPT, read: 0.1, surcharge: null }),
	).toEqual({ bestRun: 3, restartAt: 48_000 });
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
		usedAfterFirstMessage: null,
		firstMessageEvents: 0,
		messagesDone: 0,
		usedAtLastDone: 0,
		eventsAtLastDone: 0,
		prices: ONE_HOUR,
	};
	// Fallbacks reproduce the first reference: S = 66,000, C* = 156,000.
	const early = estimateRestart({ ...base, messagesSent: 1 });
	expect(early.restartAt).toBe(156_000);
	expect(early.messagesLeft).toBe(Math.floor((156_000 - 100_000) / FALLBACK_GROWTH));
	expect(FALLBACK_REQUESTS).toBe(14);
	expect(HANDOFF_TOKENS).toBe(8000);

	// Observed: a warm-up of 76,000 - 58,000 = 18,000 in 14 requests, then
	// g = 94,000 - 76,000 = 18,000 and q = 28 - 14 = 14 for the second message.
	const observed = estimateRestart({
		...base,
		usedTokens: 94_000,
		messagesSent: 2,
		contextEvents: 28,
		usedAfterFirstMessage: 76_000,
		firstMessageEvents: 14,
		messagesDone: 2,
		usedAtLastDone: 94_000,
		eventsAtLastDone: 28,
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
		usedAfterFirstMessage: 50_000,
		firstMessageEvents: 0,
		messagesDone: 4,
		usedAtLastDone: 50_000,
		eventsAtLastDone: 0,
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
		usedAfterFirstMessage: null,
		firstMessageEvents: 0,
		messagesDone: 0,
		usedAtLastDone: 0,
		eventsAtLastDone: 0,
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
		usedAfterFirstMessage: null,
		firstMessageEvents: 0,
		messagesDone: 0,
		usedAtLastDone: 0,
		eventsAtLastDone: 0,
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

describe("the first message is a warm-up", () => {
	const opus = priceRatios("claude", "claude-opus-5-5", 3600);
	/** A chat that starts at 30k and whose first message adds `warmup` tokens in `warmupRequests` requests. */
	function counts(
		warmup: number,
		warmupRequests: number,
		later: readonly (readonly [number, number])[],
	): number[] {
		const firstUsedTokens = 30_000;
		const after = firstUsedTokens + warmup;
		let used = after;
		let events = warmupRequests;
		const estimate = (messagesSent: number) =>
			estimateRestart({
				usedTokens: used,
				windowTokens: 1_000_000,
				firstUsedTokens,
				messagesSent,
				contextEvents: events,
				usedAfterFirstMessage: after,
				firstMessageEvents: warmupRequests,
				messagesDone: messagesSent,
				usedAtLastDone: used,
				eventsAtLastDone: events,
				prices: opus,
			}).messagesLeft;
		const shown = [estimate(1)];
		later.forEach(([tokens, requests], index) => {
			used += tokens;
			events += requests;
			shown.push(estimate(index + 2));
		});
		return shown;
	}
	const MIXED = [
		[6000, 4],
		[10_000, 7],
		[4000, 2],
		[12_000, 9],
		[8000, 5],
		[5000, 3],
	] as const;
	const SIMILAR = Array.from(
		{ length: 8 },
		(_, i) => [i % 2 ? 9000 : 7000, 5] as const,
	);

	test("a heavy warm-up does not make a fresh chat look cheaper right away", () => {
		for (const left of counts(45_000, 30, MIXED)) expect(left).toBeGreaterThan(0);
	});

	test("messages of similar size move the count by at most one", () => {
		// From the third message on, once the steady rate rests on observed messages.
		const shown = counts(45_000, 30, SIMILAR).slice(2);
		for (let i = 1; i < shown.length; i++) {
			expect(Math.abs((shown[i] ?? 0) - (shown[i - 1] ?? 0))).toBeLessThanOrEqual(1);
		}
	});

	test("a heavier warm-up makes restarting later, not sooner", () => {
		const light = counts(10_000, 5, SIMILAR);
		const heavy = counts(45_000, 30, SIMILAR);
		light.forEach((left, i) => {
			expect(heavy[i] ?? 0).toBeGreaterThanOrEqual(left);
		});
		expect(heavy.at(-1) ?? 0).toBeGreaterThan(light.at(-1) ?? 0);
	});

	test("the fresh chat's first message repeats the warm-up, written cold", () => {
		const start = 66_000;
		const warmup = { growth: 40_000, requests: 30 };
		// One message run: the fresh chat ends at its start plus the warm-up.
		expect(bestRestart(start, 18_000, 14, 120_000, ONE_HOUR, warmup)).toEqual({
			bestRun: 1,
			restartAt: 106_000,
		});
		const run = bestRestart(start, 18_000, 14, 1_000_000, ONE_HOUR, warmup);
		expect(run.restartAt).toBe(start + 40_000 + (run.bestRun - 1) * 18_000);
		// A costlier first message is spread over a longer run.
		expect(run.bestRun).toBeGreaterThan(
			bestRestart(start, 18_000, 14, 1_000_000, ONE_HOUR).bestRun,
		);
	});
});

test("a message still running does not move the steady rates", () => {
	const prices = priceRatios("claude", "claude-opus-5-5", 3600);
	const at = (
		usedTokens: number,
		contextEvents: number,
		messagesSent: number,
		done: { messages: number; used: number; events: number },
	) =>
		estimateRestart({
			usedTokens,
			windowTokens: 1_000_000,
			firstUsedTokens: 30_000,
			messagesSent,
			contextEvents,
			usedAfterFirstMessage: 75_000,
			firstMessageEvents: 30,
			messagesDone: done.messages,
			usedAtLastDone: done.used,
			eventsAtLastDone: done.events,
			prices,
		}).messagesLeft;
	const afterFirst = { messages: 1, used: 75_000, events: 30 };
	const settled = at(75_000, 30, 1, afterFirst);
	// Message 2 is sent and reports a few small requests before its turn ends.
	for (const [used, events] of [
		[75_000, 30],
		[75_500, 31],
		[76_000, 32],
		[77_000, 33],
	] as const) {
		const shown = at(used, events, 2, afterFirst);
		expect(shown).toBeLessThanOrEqual(settled);
		expect(settled - shown).toBeLessThanOrEqual(1);
	}
	// Once it finishes, its growth sets the steady rate.
	const afterSecond = { messages: 2, used: 81_000, events: 34 };
	const second = at(81_000, 34, 2, afterSecond);
	// Message 3 in flight: the count only falls with the live size.
	for (const [used, events] of [
		[81_000, 34],
		[82_000, 35],
		[84_000, 36],
	] as const) {
		const shown = at(used, events, 3, afterSecond);
		expect(shown).toBeLessThanOrEqual(second);
		expect(second - shown).toBeLessThanOrEqual(1);
	}
});
