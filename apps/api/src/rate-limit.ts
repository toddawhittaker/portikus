import { isIPv4, isIPv6 } from "node:net";
import type { ApiConfig } from "@portikus/config";
import type { ApiError } from "@portikus/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

/**
 * Fixed-window request counters kept in this process, which the pilot runs
 * one of (ADR 0034 ruling 15). The sign-in throttle, the preview
 * cap and the per-user limits all count with them.
 */

interface Window {
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

/**
 * Routes that need no session, as `"<METHOD> <url pattern>"`. The limit
 * cannot read the session, so it matches this fixed list (SPEC.md section
 * 24.13). `/edge/certificate-ask` is left out because Caddy asks it with no
 * client address, and `/preview/authorize` because it has its own count of
 * made-up cookies.
 */
export const ANONYMOUS_ROUTES: ReadonlySet<string> = new Set([
	"GET /health",
	"GET /auth/login",
	"HEAD /auth/login",
	"GET /auth/callback",
	"HEAD /auth/callback",
	"POST /auth/logout",
	"GET /edge/signin-throttle",
	"HEAD /edge/signin-throttle",
	"POST /dex/auth/*",
	"GET /.well-known/portikus-preflight/:nonce",
	"HEAD /.well-known/portikus-preflight/:nonce",
	"GET /lti/login",
	"HEAD /lti/login",
	"POST /lti/login",
	"POST /lti/launch",
	"POST /lti/deep-link",
	"GET /lti/jwks",
	"HEAD /lti/jwks",
	"GET /__portikus/bootstrap",
	"HEAD /__portikus/bootstrap",
	"GET /__portikus/reset",
	"HEAD /__portikus/reset",
]);

/** The answer the anonymous request limit refuses with. */
const ANONYMOUS_LIMIT_BODY: ApiError = {
	code: "RATE_LIMITED",
	message: "Too many requests from your network just now. Try again in a minute.",
};

/** One minute's requests per address, at the anonymous limit. */
export function createAnonymousCounter(
	config: ApiConfig,
	now: () => number = Date.now,
): Counter {
	return createCounter(config.ANONYMOUS_REQUEST_LIMIT_PER_MINUTE, MINUTE_MS, now);
}

function isAnonymousRoute(request: FastifyRequest): boolean {
	return ANONYMOUS_ROUTES.has(`${request.method} ${request.routeOptions.url ?? ""}`);
}

/**
 * Count every request to an anonymous route per address and answer 429 past
 * the limit. Register it before the sign-in throttle, so a refused request
 * reaches no later count.
 *
 * Returns the check for a session cookie that matches no session, which the
 * auth plugin calls: guessing cookies is anonymous work too (SPEC.md section
 * 24.13). It answers 429 and returns false past the limit.
 */
export function registerAnonymousLimit(
	app: FastifyInstance,
	config: ApiConfig,
	now: () => number = Date.now,
): (request: FastifyRequest, reply: FastifyReply) => Promise<boolean> {
	const counter = createAnonymousCounter(config, now);

	async function allow(request: FastifyRequest, reply: FastifyReply): Promise<boolean> {
		// request.ip is the client Caddy named; trustProxy trusts only loopback.
		const key = addressKey(request.ip);
		const decision = check(counter, key);
		if (decision.allowed) return true;
		if (decision.firstRefusal) {
			request.log.warn({ address: key }, "anonymous request limit reached");
		}
		await reply
			.status(429)
			.header("retry-after", String(decision.retryAfterSeconds))
			.send(ANONYMOUS_LIMIT_BODY);
		return false;
	}

	app.addHook("onRequest", async (request, reply) => {
		if (isAnonymousRoute(request)) await allow(request, reply);
	});
	// An anonymous route was counted above already.
	return async (request, reply) => isAnonymousRoute(request) || allow(request, reply);
}
