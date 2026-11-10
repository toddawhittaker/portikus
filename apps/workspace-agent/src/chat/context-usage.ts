/**
 * How full a chat's context is and when its prompt cache goes cold
 * (SPEC.md §10.8), worked out from the usage figures on Claude's
 * main-thread assistant messages.
 */

export interface ContextFigures {
	usedTokens: number;
	windowTokens: number | null;
	cache: { at: number; ttlSeconds: 300 | 3600 } | null;
}

/** The parts of an Anthropic Messages API `usage` object read here. */
interface RequestUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cacheWrite1h: number;
}

function count(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? Math.floor(value)
		: 0;
}

/**
 * The usage of a main-thread assistant message, or null for a subagent's
 * message, a message without usage, or a synthetic one that sent nothing.
 */
export function mainThreadUsage(message: {
	type: string;
	parent_tool_use_id?: string | null;
	message?: unknown;
}): RequestUsage | null {
	if (message.type !== "assistant" || message.parent_tool_use_id) return null;
	const body = message.message as { usage?: Record<string, unknown> } | undefined;
	const usage = body?.usage;
	if (!usage || typeof usage !== "object") return null;
	const creation = usage.cache_creation as Record<string, unknown> | null | undefined;
	const figures: RequestUsage = {
		input: count(usage.input_tokens),
		output: count(usage.output_tokens),
		cacheRead: count(usage.cache_read_input_tokens),
		cacheWrite: count(usage.cache_creation_input_tokens),
		cacheWrite1h: count(creation?.ephemeral_1h_input_tokens),
	};
	if (figures.input + figures.cacheRead + figures.cacheWrite === 0) return null;
	return figures;
}

/**
 * The figures after one main-thread request made at `at`. The context in
 * use for the next request is everything this one sent plus what it wrote
 * back. Reading a cache entry refreshes its lifetime, so any request that
 * read or wrote the cache restarts the clock. A request that only read
 * keeps the lifetime the entry was written with, when that is known.
 */
export function afterRequest(
	previous: ContextFigures | null,
	usage: RequestUsage,
	at: number | null,
	windowTokens: number | null,
): ContextFigures {
	return {
		usedTokens: usage.input + usage.cacheRead + usage.cacheWrite + usage.output,
		windowTokens,
		cache: nextCache(previous?.cache ?? null, usage, at),
	};
}

function nextCache(
	previous: ContextFigures["cache"],
	usage: RequestUsage,
	at: number | null,
): ContextFigures["cache"] {
	if (usage.cacheRead === 0 && usage.cacheWrite === 0) return previous;
	if (at === null) return null;
	if (usage.cacheWrite1h > 0) return { at, ttlSeconds: 3600 };
	if (usage.cacheWrite > 0) return { at, ttlSeconds: 300 };
	return { at, ttlSeconds: previous?.ttlSeconds ?? 300 };
}

/**
 * The figures from a transcript, for an attach before this host has seen
 * a request. The transcript carries no times, so the cache is unknown.
 */
export function fromTranscript(
	messages: readonly {
		type: string;
		parent_tool_use_id?: string | null;
		message?: unknown;
	}[],
	windowTokens: number | null,
): ContextFigures | null {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		const usage = message ? mainThreadUsage(message) : null;
		if (usage) return afterRequest(null, usage, null, windowTokens);
	}
	return null;
}

/** The context window from a result's `modelUsage`, for the model named or the only one. */
export function windowFromModelUsage(
	modelUsage: Record<string, { contextWindow?: number }> | undefined,
	model: string | null,
): number | null {
	if (!modelUsage) return null;
	const entries = Object.entries(modelUsage);
	const entry =
		(model ? modelUsage[model] : undefined) ??
		(entries.length === 1 ? entries[0]?.[1] : undefined);
	const window = count(entry?.contextWindow);
	return window > 0 ? window : null;
}
