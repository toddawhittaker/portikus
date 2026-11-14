/**
 * How many more messages the student can send before a fresh chat would use
 * less of their plan (SPEC.md §10.8). Every request re-reads the whole
 * conversation, so a long chat costs more per message; this compares that
 * with a fresh chat that starts from a handoff note. It assumes plan usage
 * tracks API prices, so it is an estimate.
 */

import { HANDOFF_TOKENS } from "@portikus/contracts";

export interface PriceRatios {
	/** A cache read, as a multiple of the model's input price. */
	read: number;
	/** A cache write, as a multiple of the model's input price. */
	write: number;
	/** Every price is multiplied by `factor` on a message whose context passes `above` tokens. */
	surcharge: { above: number; factor: number } | null;
}

/**
 * Price ratios by model. Claude: the Claude pricing page. Codex: OpenAI's
 * API prices, since subscription metering is not published. A cache write
 * is 1.25 times the input price for the default 30-minute cache (OpenAI's
 * prompt-caching guide). A cache read is a twentieth of the input price for
 * GPT-6.1 ($0.10 cached against $2 input on OpenAI's API pricing page) and
 * a tenth for older models; GPT-6.1 doubles every price past 272k tokens.
 * Checked 14 November 2026.
 */
const PRICE_TABLE = {
	claude: {
		readByModel: [
			{ contains: "opus-5-5", read: 0.05 },
			{ contains: "sonnet-5-5", read: 0.05 },
			{ contains: "fable-5", read: 0.025 },
			{ contains: "mythos-5", read: 0.025 },
		],
		read: 0.1,
		writeOneHour: 2,
		writeFiveMinutes: 1.25,
		surcharge: { contains: "haiku-5-5", above: 100_000, factor: 5 },
	},
	codex: {
		prefix: "gpt-6.1",
		prefixRead: 0.05,
		read: 0.1,
		write: 1.25,
		prefixSurcharge: { above: 272_000, factor: 2 },
	},
} as const;

export { HANDOFF_TOKENS };
/** Context growth per message until two messages have been seen. */
export const FALLBACK_GROWTH = 18_000;
/** Requests to the model per message until two messages have been seen. */
export const FALLBACK_REQUESTS = 14;
const MIN_GROWTH = 1000;
const MIN_REQUESTS = 1;
const WINDOW_SHARE = 0.9;

export function priceRatios(
	agent: "claude" | "codex",
	model: string,
	cacheTtlSeconds: number | null,
): PriceRatios {
	if (agent === "codex") {
		const t = PRICE_TABLE.codex;
		const newest = model.startsWith(t.prefix);
		return {
			read: newest ? t.prefixRead : t.read,
			write: t.write,
			surcharge: newest ? t.prefixSurcharge : null,
		};
	}
	const t = PRICE_TABLE.claude;
	const read =
		t.readByModel.find((row) => model.includes(row.contains))?.read ?? t.read;
	const write =
		cacheTtlSeconds !== null && cacheTtlSeconds >= 3600
			? t.writeOneHour
			: t.writeFiveMinutes;
	const surcharge = model.includes(t.surcharge.contains)
		? { above: t.surcharge.above, factor: t.surcharge.factor }
		: null;
	return { read, write, surcharge };
}

export interface RestartInputs {
	usedTokens: number;
	windowTokens: number;
	firstUsedTokens: number;
	messagesSent: number;
	contextEvents: number;
	prices: PriceRatios;
	/** The prompt cache is known to have expired, so the next message re-writes it. */
	cold?: boolean;
}

export interface RestartEstimate {
	/** Messages left before a fresh chat would be cheaper; never negative. */
	messagesLeft: number;
	/** The cheapest size to restart at. */
	restartAt: number;
	/** Messages per run that make a fresh chat cheapest. */
	bestRun: number;
}

/** Growth and requests per message: observed after two messages, else the fallbacks. */
function chatRates(inputs: RestartInputs): { growth: number; requests: number } {
	if (inputs.messagesSent < 2) {
		return { growth: FALLBACK_GROWTH, requests: FALLBACK_REQUESTS };
	}
	return {
		growth: Math.max(
			MIN_GROWTH,
			(inputs.usedTokens - inputs.firstUsedTokens) / inputs.messagesSent,
		),
		requests: Math.max(MIN_REQUESTS, inputs.contextEvents / inputs.messagesSent),
	};
}

/** The cost of one message sent at context size `size`, in input-price tokens. */
export function messageCost(
	size: number,
	cold: boolean,
	growth: number,
	requests: number,
	prices: PriceRatios,
): number {
	const { read, write, surcharge } = prices;
	const mult = surcharge && size + growth > surcharge.above ? surcharge.factor : 1;
	return (
		mult *
		((cold ? write : read) * size +
			(requests - 1) * read * (size + growth / 2) +
			write * growth)
	);
}

/** The best run length and restart size for a fresh chat starting at `start`. */
export function bestRestart(
	start: number,
	growth: number,
	requests: number,
	windowTokens: number,
	prices: PriceRatios,
): { bestRun: number; restartAt: number } {
	const maxRun = Math.max(
		1,
		Math.floor((WINDOW_SHARE * windowTokens - start) / growth),
	);
	let total = 0;
	let bestRun = 1;
	let bestAverage = Number.POSITIVE_INFINITY;
	for (let run = 1; run <= maxRun; run++) {
		total += messageCost(
			start + (run - 1) * growth,
			run === 1,
			growth,
			requests,
			prices,
		);
		const average = total / run;
		if (average < bestAverage) {
			bestAverage = average;
			bestRun = run;
		}
	}
	return { bestRun, restartAt: start + bestRun * growth };
}

export function estimateRestart(inputs: RestartInputs): RestartEstimate {
	const { growth, requests } = chatRates(inputs);
	const start = inputs.firstUsedTokens + HANDOFF_TOKENS;
	const { bestRun, restartAt } = bestRestart(
		start,
		growth,
		requests,
		inputs.windowTokens,
		inputs.prices,
	);
	if (
		inputs.cold &&
		coldCostsMore(inputs.usedTokens, start, growth, requests, inputs.prices)
	) {
		return { messagesLeft: 0, restartAt, bestRun };
	}
	const messagesLeft = Math.max(
		0,
		Math.floor((restartAt - inputs.usedTokens) / growth),
	);
	return { messagesLeft, restartAt, bestRun };
}

/**
 * With the cache cold, the next message here re-writes the whole chat, as a
 * fresh chat's first message writes its start. A fresh chat now saves usage
 * when the extra cost of that write here is more than it is there.
 */
function coldCostsMore(
	used: number,
	start: number,
	growth: number,
	requests: number,
	prices: PriceRatios,
): boolean {
	const extra = (size: number) =>
		messageCost(size, true, growth, requests, prices) -
		messageCost(size, false, growth, requests, prices);
	return extra(used) > extra(start);
}
