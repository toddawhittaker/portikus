import type { ApiConfig } from "@portikus/config";
import type { ApiError } from "@portikus/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

/**
 * Fixed-window request counters kept in this process, which the pilot runs
 * one of (docs/EPIC-17.md ruling 15). The sign-in throttle, the preview
 * cap and the per-user limits all count with them.
 */

export interface Window {
	startedAt: number;
	count: number;
	/** Set once the first refusal in this window has been reported. */
	reported: boolean;
}

export interface Counter {
	/** Count one request and return its window. */
	hit(key: string): Window;
	/** The window as it stands, without counting. */
	peek(key: string): Window;
	/** Whole seconds until this window ends, at least one. */
	retryAfterSeconds(window: Window): number;
	readonly limit: number;
}

/** Fixed windows keyed by whatever the caller counts: an address, a user, a session. */
export function createCounter(
	limit: number,
	windowMs: number,
	now: () => number = Date.now,
): Counter {
	const windows = new Map<string, Window>();
	let lastSweep = now();

	function current(key: string): Window {
		const at = now();
		// Drop old windows now and then, so a flood of keys cannot pile up.
		if (at - lastSweep >= windowMs) {
			for (const [k, w] of windows) if (at - w.startedAt >= windowMs) windows.delete(k);
			lastSweep = at;
		}
		let window = windows.get(key);
		if (!window || at - window.startedAt >= windowMs) {
			window = { startedAt: at, count: 0, reported: false };
			windows.set(key, window);
		}
		return window;
	}

	return {
		hit(key) {
			const window = current(key);
			window.count += 1;
			return window;
		},
		peek: current,
		retryAfterSeconds(window) {
			return Math.max(1, Math.ceil((window.startedAt + windowMs - now()) / 1000));
		},
		limit,
	};
}

export interface LimitDecision {
	allowed: boolean;
	/** True for the first refusal of this key in its window. */
	firstRefusal: boolean;
	retryAfterSeconds: number;
}

/** Count one request for `key` and say whether it is within the limit. */
export function check(counter: Counter, key: string): LimitDecision {
	const window = counter.hit(key);
	if (window.count <= counter.limit) {
		return { allowed: true, firstRefusal: false, retryAfterSeconds: 0 };
	}
	const firstRefusal = !window.reported;
	window.reported = true;
	return {
		allowed: false,
		firstRefusal,
		retryAfterSeconds: counter.retryAfterSeconds(window),
	};
}

const MINUTE_MS = 60_000;

/**
 * Answer 429 when this user is over `counter`'s limit and return false;
 * return true to let the request through. One warning per user per window.
 */
async function allowUser(
	counter: Counter,
	scope: string,
	request: FastifyRequest,
	reply: FastifyReply,
): Promise<boolean> {
	// Unauthenticated requests are refused by the route itself.
	const userId = request.user?.id;
	if (!userId) return true;
	const decision = check(counter, userId);
	if (decision.allowed) return true;
	if (decision.firstRefusal) {
		request.log.warn({ userId, scope }, "per-user rate limit reached");
	}
	const body: ApiError = {
		code: "RATE_LIMITED",
		message: "Too many requests just now. Try again in a minute.",
	};
	await reply
		.status(429)
		.header("retry-after", String(decision.retryAfterSeconds))
		.send(body);
	return false;
}

export type UserLimit = (
	request: FastifyRequest,
	reply: FastifyReply,
) => Promise<boolean>;

export function createUserLimit(scope: string, counter: Counter): UserLimit {
	return (request, reply) => allowUser(counter, scope, request, reply);
}

// files.ts and projects.ts share one file-write count per server, so it
// hangs off the root instance both of them are handed.
const fileWriteLimits = new WeakMap<FastifyInstance, UserLimit>();

/** The per-user limit on file and project writes (ruling 16). */
export function fileWriteLimit(app: FastifyInstance, config: ApiConfig): UserLimit {
	let limit = fileWriteLimits.get(app);
	if (!limit) {
		limit = createUserLimit(
			"file-write",
			createCounter(config.FILE_WRITE_LIMIT_PER_MINUTE, MINUTE_MS),
		);
		fileWriteLimits.set(app, limit);
	}
	return limit;
}

/** The per-user limit on workspace start, stop and restart (ruling 16). */
export function lifecycleLimit(config: ApiConfig): UserLimit {
	return createUserLimit(
		"workspace-lifecycle",
		createCounter(config.WORKSPACE_LIFECYCLE_LIMIT_PER_MINUTE, MINUTE_MS),
	);
}
