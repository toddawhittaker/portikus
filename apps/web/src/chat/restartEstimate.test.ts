import { describe, expect, test } from "vitest";
import {
	bestRestart,
	estimateRestart,
	HANDOFF_TOKENS,
	hasEnoughToEstimate,
	MIN_MESSAGES,
	MIN_USED_TOKENS,
	messageCost,
	type PriceRatios,
	priceRatios,
	pricingModel,
} from "./restartEstimate.js";

/** The estimate where the test expects one; null fails it. */
function shown(estimate: ReturnType<typeof estimateRestart>) {
	if (!estimate) throw new Error("no estimate was shown");
	return estimate;
}

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

test("the steady rates come from messages after the first", () => {
	const base = {
		usedTokens: 94_000,
		windowTokens: 1_000_000,
		firstUsedTokens: 58_000,
		contextEvents: 28,
		usedAfterFirstMessage: 76_000,
		firstMessageEvents: 14,
		messagesSent: 2,
		messagesDone: 2,
		usedAtLastDone: 94_000,
		eventsAtLastDone: 28,
		prices: ONE_HOUR,
	};
	expect(HANDOFF_TOKENS).toBe(8000);
	// Warm-up 18,000 in 14 requests; then g = 94,000 - 76,000 = 18,000 and q = 28 - 14 = 14.
	expect(shown(estimateRestart(base))).toEqual({
		messagesLeft: 3,
		restartAt: 156_000,
		bestRun: 5,
	});
});

describe("the gate", () => {
	const at = (usedTokens: number, messagesDone: number) =>
		estimateRestart({
			usedTokens,
			windowTokens: 1_000_000,
			firstUsedTokens: 26_313,
			messagesSent: messagesDone,
			contextEvents: 3 * messagesDone,
			usedAfterFirstMessage: 28_328,
			firstMessageEvents: 3,
			messagesDone,
			usedAtLastDone: usedTokens,
			eventsAtLastDone: 3 * messagesDone,
			prices: priceRatios("claude", pricingModel(undefined, "opus"), 3600),
		});

	test("the thresholds are 60,000 tokens and 5 messages", () => {
		expect([MIN_USED_TOKENS, MIN_MESSAGES]).toEqual([60_000, 5]);
	});

	test("the pilot chat (one message, 28,328 tokens) shows nothing", () => {
		expect(at(28_328, 1)).toBeNull();
	});

	test("the first message is never the steady rate: one finished message at 61,000 is hidden", () => {
		expect(at(61_000, 1)).toBeNull();
		expect(hasEnoughToEstimate(61_000, 1)).toBe(false);
	});

	test("nothing is shown before a message has finished, however large", () => {
		expect(at(200_000, 0)).toBeNull();
		expect(hasEnoughToEstimate(200_000, 0)).toBe(false);
	});

	test("two finished messages at 61,000 tokens are shown", () => {
		expect(at(61_000, 2)).not.toBeNull();
	});

	test("4 finished messages at 40,000 tokens are hidden; 5 are shown", () => {
		expect(at(40_000, 4)).toBeNull();
		expect(at(40_000, 5)).not.toBeNull();
	});

	test("past the gate a small-growth chat gets a sensible count", () => {
		// 61,000 after two messages: growth is (61,000 - 28,328) in one later message, so use five.
		expect(shown(at(61_000, 5)).messagesLeft).toBeGreaterThanOrEqual(0);
	});
});

describe("the model that is priced", () => {
	test("an alias maps to the API id, which has the 0.05 cache read", () => {
		expect(pricingModel(undefined, "opus")).toBe("claude-opus-5-5");
		expect(pricingModel(undefined, "sonnet")).toBe("claude-sonnet-5-5");
		expect(pricingModel(undefined, "haiku")).toBe("claude-haiku-5-5");
		expect(pricingModel(undefined, "fable")).toBe("claude-fable-5-2");
		expect(priceRatios("claude", pricingModel(undefined, "opus"), 3600).read).toBe(
			0.05,
		);
	});

	test("the id the agent reported wins over the setting", () => {
		expect(pricingModel("claude-opus-5-5", "sonnet")).toBe("claude-opus-5-5");
	});

	test("a [1m] suffix is dropped before the lookup", () => {
		expect(pricingModel(undefined, "opus[1m]")).toBe("claude-opus-5-5");
		expect(pricingModel(undefined, "claude-sonnet-5-5[1m]")).toBe("claude-sonnet-5-5");
	});

	test("an unknown name passes through", () => {
		expect(pricingModel(undefined, "gpt-6.1-sol")).toBe("gpt-6.1-sol");
	});
});

test("growth is floored at 1000 and requests at 1", () => {
	const flat = shown(
		estimateRestart({
			usedTokens: 50_000,
			windowTokens: 1_000_000,
			firstUsedTokens: 50_000,
			messagesSent: 5,
			contextEvents: 0,
			usedAfterFirstMessage: 50_000,
			firstMessageEvents: 0,
			messagesDone: 5,
			usedAtLastDone: 50_000,
			eventsAtLastDone: 0,
			prices: ONE_HOUR,
		}),
	);
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
	const late = shown(
		estimateRestart({
			usedTokens: 900_000,
			windowTokens: 1_000_000,
			firstUsedTokens: 58_000,
			messagesSent: 2,
			contextEvents: 28,
			usedAfterFirstMessage: 76_000,
			firstMessageEvents: 14,
			messagesDone: 2,
			usedAtLastDone: 94_000,
			eventsAtLastDone: 28,
			prices: ONE_HOUR,
		}),
	);
	expect(late.messagesLeft).toBe(0);
});

describe("a cold cache", () => {
	// Used 300k, a fresh chat starting at S = 48k + 8k = 56k, read 0.05, write 2.
	const inputs = {
		usedTokens: 300_000,
		windowTokens: 1_000_000,
		firstUsedTokens: 48_000,
		messagesSent: 2,
		contextEvents: 28,
		usedAfterFirstMessage: 66_000,
		firstMessageEvents: 14,
		messagesDone: 2,
		usedAtLastDone: 84_000,
		eventsAtLastDone: 28,
		prices: ONE_HOUR,
	};

	test("prices the next message here as a re-write, so a fresh chat saves usage now", () => {
		// Extra here: 1.95 x 300k = 585k; extra in a fresh chat: 1.95 x 56k = 109.2k.
		expect(shown(estimateRestart({ ...inputs, cold: true })).messagesLeft).toBe(0);
	});

	test("a warm or unknown cache keeps the renewal estimate", () => {
		const small = {
			...inputs,
			firstUsedTokens: 52_000,
			usedTokens: 60_000,
			usedAtLastDone: 60_000,
		};
		const warm = shown(estimateRestart(small));
		expect(warm.messagesLeft).toBeGreaterThan(0);
		// At the fresh chat's own size (52k + 8k), a cold write costs the same either way.
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
	): (number | null)[] {
		const firstUsedTokens = 30_000;
		const after = firstUsedTokens + warmup;
		let used = after;
		let events = warmupRequests;
		// Null while the gate keeps the estimate hidden.
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
			})?.messagesLeft ?? null;
		const steps = [estimate(1)];
		later.forEach(([tokens, requests], index) => {
			used += tokens;
			events += requests;
			steps.push(estimate(index + 2));
		});
		return steps;
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
		const left = counts(45_000, 30, MIXED);
		expect(left.some((n) => n !== null)).toBe(true);
		for (const n of left) if (n !== null) expect(n).toBeGreaterThan(0);
	});

	test("messages of similar size move the count by at most one", () => {
		// From the third message on, once the steady rate rests on observed messages.
		const steps = counts(45_000, 30, SIMILAR).slice(2);
		for (let i = 1; i < steps.length; i++) {
			expect(Math.abs((steps[i] ?? 0) - (steps[i - 1] ?? 0))).toBeLessThanOrEqual(1);
		}
	});

	test("a heavier warm-up makes restarting later, not sooner", () => {
		const light = counts(10_000, 5, SIMILAR);
		const heavy = counts(45_000, 30, SIMILAR);
		// Compared from the fifth message, when both chats are past the gate.
		light.forEach((left, i) => {
			if (i >= 4) expect(heavy[i] ?? 0).toBeGreaterThanOrEqual(left ?? 0);
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
		shown(
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
			}),
		).messagesLeft;
	// Message 2 has finished; its growth sets the steady rate.
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
