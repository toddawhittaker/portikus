/**
 * How many more messages the student can send before a fresh chat would use
 * less of their plan (SPEC.md §10.8). Every request re-reads the whole
 * conversation, so a long chat costs more per message; this compares that
 * with a fresh chat that starts from a handoff note. The first message is
 * a warm-up: it is left out of the steady per-message rates, and the fresh chat is
 * assumed to repeat it. It assumes plan usage tracks API prices, so it is an estimate.
 */

import { HANDOFF_TOKENS, type ModelPrice, PricingTable } from "@portikus/contracts";
import { request } from "../api/request.js";

export interface PriceRatios {
	/** A cache read, as a multiple of the model's input price. */
	read: number;
	/** A cache write, as a multiple of the model's input price. */
	write: number;
	/** Every price is multiplied by `factor` on a message whose context passes `above` tokens. */
	surcharge: { above: number; factor: number } | null;
}

/**
 * The built-in price ratios, used for a model the site's table has no row
 * for. Claude: the Claude pricing page. Codex: OpenAI's
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

/**
 * The estimate waits for two finished messages (the first is a warm-up, never
 * the steady rate) and then for a context this large or MIN_MESSAGES finished
 * messages, whichever comes first (SPEC.md §10.8).
 */
const MIN_FINISHED = 2;
export const MIN_USED_TOKENS = 60_000;
export const MIN_MESSAGES = 5;
const MIN_GROWTH = 1000;
const MIN_REQUESTS = 1;
const WINDOW_SHARE = 0.9;

// The site's price table, read once per page load; null until it arrives or
// when it could not be read, and then the built-in table answers.
let siteTable: readonly ModelPrice[] | null = null;
let loading: Promise<void> | null = null;

/** Start reading `GET /pricing`, once per page load; the chat calls it on mount. Failures stay silent. */
export function loadPriceTable(): Promise<void> {
	loading ??= request(PricingTable, "/pricing").then(
		(table) => {
			siteTable = table.prices;
		},
		() => undefined,
	);
	return loading;
}

/** For tests: forget the table read so far. */
export function resetPriceTable(): void {
	siteTable = null;
	loading = null;
}

/**
 * The names the settings picker uses for Claude's model families, mapped to
 * the API ids the price rows and built-in table are keyed by. The host's own
 * reported id is used instead whenever it has one.
 */
const CLAUDE_ALIASES: Record<string, string> = {
	opus: "claude-opus-5-5",
	sonnet: "claude-sonnet-5-5",
	haiku: "claude-haiku-5-5",
	fable: "claude-fable-5-2",
};

/** The model id to price with: the id the agent reported, else the setting with an alias spelled out and a `[1m]` suffix dropped. */
export function pricingModel(reported: string | undefined, setting: string): string {
	const name = (reported || setting).replace(/\[1m\]$/, "");
	return CLAUDE_ALIASES[name] ?? name;
}

/** A dated release of a model, such as claude-opus-5-5-20261101. */
const DATE_SUFFIX = /^-\d{8}$/;

/**
 * The site row for exactly this model, or for the model this dated release
 * belongs to, for the agent's provider. Never a substring: gpt-5 is not gpt-5-mini.
 */
function siteRow(agent: "claude" | "codex", model: string): ModelPrice | null {
	const provider = agent === "codex" ? "openai" : "anthropic";
	const rows = (siteTable ?? []).filter((row) => row.provider === provider);
	return (
		rows.find((row) => row.model === model) ??
		rows.find(
			(row) =>
				model.startsWith(row.model) && DATE_SUFFIX.test(model.slice(row.model.length)),
		) ??
		null
	);
}

export function priceRatios(
	agent: "claude" | "codex",
	model: string,
	cacheTtlSeconds: number | null,
): PriceRatios {
	const row = siteRow(agent, model);
	if (row) {
		const oneHour = cacheTtlSeconds !== null && cacheTtlSeconds >= 3600;
		return {
			read: row.cacheReadRatio,
			write:
				oneHour && row.cacheWriteOneHourRatio !== null
					? row.cacheWriteOneHourRatio
					: row.cacheWriteRatio,
			surcharge:
				row.surchargeAboveTokens !== null && row.surchargeFactor !== null
					? { above: row.surchargeAboveTokens, factor: row.surchargeFactor }
					: null,
		};
	}
	return builtInRatios(agent, model, cacheTtlSeconds);
}

function builtInRatios(
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
	/** Context size once the first message finished; null until it has. */
	usedAfterFirstMessage: number | null;
	/** Requests to the model the first message took. */
	firstMessageEvents: number;
	/** Messages whose turn has finished; a running one never counts toward the rates. */
	messagesDone: number;
	/** Context size when the last finished turn ended. */
	usedAtLastDone: number;
	/** Requests to the model by the end of the last finished turn. */
	eventsAtLastDone: number;
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

export interface Rates {
	growth: number;
	requests: number;
}

/**
 * The first message is a warm-up (the agent explores the project), so it is
 * kept out of the steady rates and repeated by a fresh chat. The steady rates
 * come from finished messages only, so a running one cannot swing them (SPEC.md §10.8).
 */
function chatRates(
	inputs: RestartInputs,
	after: number,
): { steady: Rates; warmup: Rates } {
	const warmup = {
		growth: Math.max(MIN_GROWTH, after - inputs.firstUsedTokens),
		requests: Math.max(MIN_REQUESTS, inputs.firstMessageEvents),
	};
	const later = inputs.messagesDone - 1;
	return {
		steady: {
			growth: Math.max(MIN_GROWTH, (inputs.usedAtLastDone - after) / later),
			requests: Math.max(
				MIN_REQUESTS,
				(inputs.eventsAtLastDone - inputs.firstMessageEvents) / later,
			),
		},
		warmup,
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

/**
 * The best run length and restart size for a fresh chat starting at `start`.
 * Its first message costs `warmup`, written cold; later ones grow at the steady rates.
 */
export function bestRestart(
	start: number,
	growth: number,
	requests: number,
	windowTokens: number,
	prices: PriceRatios,
	warmup: Rates = { growth, requests },
): { bestRun: number; restartAt: number } {
	const sizeAfter = (run: number) => start + warmup.growth + (run - 1) * growth;
	const maxRun = Math.max(
		1,
		Math.floor((WINDOW_SHARE * windowTokens - start - warmup.growth) / growth) + 1,
	);
	let total = messageCost(start, true, warmup.growth, warmup.requests, prices);
	let bestRun = 1;
	let bestAverage = total;
	for (let run = 2; run <= maxRun; run++) {
		total += messageCost(sizeAfter(run - 1), false, growth, requests, prices);
		const average = total / run;
		if (average < bestAverage) {
			bestAverage = average;
			bestRun = run;
		}
	}
	return { bestRun, restartAt: sizeAfter(bestRun) };
}

/** The estimate is shown only once a message has finished and the chat is big or long enough to judge. */
export function hasEnoughToEstimate(usedTokens: number, messagesDone: number): boolean {
	return (
		messagesDone >= MIN_FINISHED &&
		(usedTokens >= MIN_USED_TOKENS || messagesDone >= MIN_MESSAGES)
	);
}

/** The estimate, or null before there is enough of the chat to judge by. */
export function estimateRestart(inputs: RestartInputs): RestartEstimate | null {
	const after = inputs.usedAfterFirstMessage;
	if (after === null || !hasEnoughToEstimate(inputs.usedTokens, inputs.messagesDone))
		return null;
	const { steady, warmup } = chatRates(inputs, after);
	const { growth, requests } = steady;
	const start = inputs.firstUsedTokens + HANDOFF_TOKENS;
	const { bestRun, restartAt } = bestRestart(
		start,
		growth,
		requests,
		inputs.windowTokens,
		inputs.prices,
		warmup,
	);
	if (
		inputs.cold &&
		coldCostsMore(inputs.usedTokens, start, steady, warmup, inputs.prices)
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
	steady: Rates,
	warmup: Rates,
	prices: PriceRatios,
): boolean {
	const extra = (size: number, rates: Rates) =>
		messageCost(size, true, rates.growth, rates.requests, prices) -
		messageCost(size, false, rates.growth, rates.requests, prices);
	return extra(used, steady) > extra(start, warmup);
}
