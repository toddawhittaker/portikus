import { isIPv4, isIPv6 } from "node:net";
import type { ApiConfig } from "@portikus/config";
import type { ApiError } from "@portikus/contracts";
import type { FastifyReply, FastifyRequest } from "fastify";

/**
 * Fixed-window request counters kept in this process, which the pilot runs
 * one of (ADR 0034 ruling 15). The sign-in throttle, the preview
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
	/** How many keys are held now; old ones are dropped as time passes. */
	size(): number;
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
		size: () => windows.size,
	};
}

/**
 * The key a per-address limit counts under. One IPv6 /64 is one subscriber,
 * who can use any of its addresses, so it counts as one (SPEC.md section 24.13).
 */
export function addressKey(ip: string): string {
	const mapped = ip.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
	if (mapped?.[1] && isIPv4(mapped[1])) return mapped[1];
	if (!isIPv6(ip)) return ip;
	const [head = "", tail = ""] = ip.toLowerCase().split("%")[0]?.split("::") ?? [];
	const headParts = head ? head.split(":") : [];
	const tailParts = tail ? tail.split(":") : [];
	const missing = 8 - headParts.length - tailParts.length;
	const groups = ip.includes("::")
		? [...headParts, ...Array<string>(missing).fill("0"), ...tailParts]
		: headParts;
	const prefix = groups.slice(0, 4).map((g) => Number.parseInt(g, 16).toString(16));
	return `${prefix.join(":")}::/64`;
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

function createUserLimit(scope: string, counter: Counter): UserLimit {
	return (request, reply) => allowUser(counter, scope, request, reply);
}

/**
 * The per-user limit on file and project writes. buildServer
 * makes one and hands it to both the files and projects routes.
 */
export function fileWriteLimit(config: ApiConfig): UserLimit {
	return createUserLimit(
		"file-write",
		createCounter(config.FILE_WRITE_LIMIT_PER_MINUTE, MINUTE_MS),
	);
}

/** Test alerts reach outside services; a handful a minute is plenty for checking a channel. */
export const TEST_ALERTS_PER_MINUTE = 5;

/** The per-user limit on `POST /admin/alerts/test`. */
export function testAlertLimit(): UserLimit {
	return createUserLimit(
		"test-alert",
		createCounter(TEST_ALERTS_PER_MINUTE, MINUTE_MS),
	);
}

/** The per-user limit on workspace start, stop and restart. */
export function lifecycleLimit(config: ApiConfig): UserLimit {
	return createUserLimit(
		"workspace-lifecycle",
		createCounter(config.WORKSPACE_LIFECYCLE_LIMIT_PER_MINUTE, MINUTE_MS),
	);
}
