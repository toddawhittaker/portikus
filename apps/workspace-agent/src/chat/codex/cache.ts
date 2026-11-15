import type { ContextFigures } from "../agent.js";

/**
 * Codex's prompt cache (SPEC.md §10.8). Codex reports no cache lifetime, so
 * this assumes OpenAI's documented API default: GPT-5.6 and later keep a
 * cache for 30 minutes, and each read renews that. Subscriptions are assumed
 * to behave the same.
 */
const CODEX_CACHE_TTL_SECONDS = 1800;

/** GPT-5.6 and later, GPT-6 and later: the models with the 30-minute default. */
const THIRTY_MINUTE_MODEL = /^gpt-(5\.([6-9]|[1-9][0-9])|[6-9])(?![0-9])/;

/** The cache figures for a request to `model` at `at`; null for older models. */
export function codexCache(model: string, at: number): ContextFigures["cache"] {
	return THIRTY_MINUTE_MODEL.test(model)
		? { at, ttlSeconds: CODEX_CACHE_TTL_SECONDS }
		: null;
}
