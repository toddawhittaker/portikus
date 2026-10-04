import type { ApiConfig } from "@portikus/config";
import type { ApiError } from "@portikus/contracts";
import { type Database, recordAudit } from "@portikus/db";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Kysely } from "kysely";
import { fromLoopback } from "./loopback.js";
import { addressKey, createCounter, type Window } from "./rate-limit.js";

/**
 * The sign-in rate limit (SPEC.md section 5.3). Counts live in this process, which the pilot runs one of.
 */

const MINUTE_MS = 60_000;
const TEN_MINUTES_MS = 10 * MINUTE_MS;
/**
 * Wrong passwords one account may take in ten minutes from browsers it has
 * not signed in on before; the same as the password change form's limit.
 */
export const ACCOUNT_FAILURE_LIMIT = 10;
/** The path Caddy asks about for Dex's sign-in pages and password form. */
const EDGE_THROTTLE_PATH = "/edge/signin-throttle";
// An LTI launch is a sign-in start too.
const START_ROUTES = new Set([
	"/auth/login",
	"/auth/callback",
	"/lti/login",
	"/lti/launch",
]);

export interface ThrottleDecision {
	allowed: boolean;
	/** True for the first refusal of this address in its window. */
	audit: boolean;
}

function decide(window: Window, refused: boolean): ThrottleDecision {
	if (!refused) return { allowed: true, audit: false };
	const audit = !window.reported;
	window.reported = true;
	return { allowed: false, audit };
}

/** Dex compares logins without case, so the count does too. */
export function accountKey(login: string): string {
	return login.trim().toLowerCase();
}

export type SigninThrottle = ReturnType<typeof createSigninThrottle>;

export function createSigninThrottle(options: {
	startLimitPerMinute: number;
	passwordLimitPer10Minutes: number;
	now?: () => number;
}) {
	const now = options.now ?? Date.now;
	const starts = createCounter(options.startLimitPerMinute, MINUTE_MS, now);
	const passwords = createCounter(
		options.passwordLimitPer10Minutes,
		TEN_MINUTES_MS,
		now,
	);
	const accountFailures = createCounter(ACCOUNT_FAILURE_LIMIT, TEN_MINUTES_MS, now);

	// No site-wide count: other clients' failures never refuse a client
	// (SPEC.md section 24.13).
	return {
		checkStart(ip: string): ThrottleDecision {
			const window = starts.hit(addressKey(ip));
			return decide(window, window.count > starts.limit);
		},
		/** Counts every password post from this address, right or wrong. */
		checkPassword(ip: string): ThrottleDecision {
			const window = passwords.hit(addressKey(ip));
			return decide(window, window.count > passwords.limit);
		},
		/** Whether this account may try a password now; counts nothing. */
		checkAccount(login: string): ThrottleDecision {
			const window = accountFailures.peek(accountKey(login));
			return decide(window, window.count >= accountFailures.limit);
		},
		/** Count one wrong password against this account. */
		accountFailed(login: string): void {
			accountFailures.hit(accountKey(login));
		},
	};
}

/**
 * Count sign-in starts and Dex password posts before the auth hook runs, so
 * the edge check needs no session. Call before registering the auth plugin.
 */
export function registerSigninThrottle(
	app: FastifyInstance,
	deps: { db: Kysely<Database>; config: ApiConfig },
): SigninThrottle {
	const throttle = createSigninThrottle({
		startLimitPerMinute: deps.config.SIGNIN_START_LIMIT_PER_MINUTE,
		passwordLimitPer10Minutes: deps.config.PASSWORD_ATTEMPT_LIMIT_PER_10_MINUTES,
	});

	async function refuse(
		request: FastifyRequest,
		reply: FastifyReply,
		decision: ThrottleDecision,
		scope: "signin-start" | "password",
	): Promise<void> {
		if (decision.audit) {
			try {
				await recordAudit(deps.db, {
					actor: "unknown",
					target: "unknown",
					action: "auth.throttled",
					result: "denied",
					metadata: { ip: request.ip, scope },
				});
			} catch (error) {
				request.log.error({ err: error }, "could not audit a sign-in throttle");
			}
		}
		const body: ApiError = {
			code: "RATE_LIMITED",
			message: "Too many sign-in attempts. Please wait a few minutes and try again.",
		};
		await reply.status(429).send(body);
	}

	app.addHook("onRequest", async (request, reply) => {
		const url = request.routeOptions.url ?? "";
		if (START_ROUTES.has(url)) {
			const decision = throttle.checkStart(request.ip);
			if (!decision.allowed) await refuse(request, reply, decision, "signin-start");
			return;
		}
		if (url !== EDGE_THROTTLE_PATH) return;
		// Only Caddy on this machine may ask. The peer address is checked, not
		// request.ip, which trustProxy lets X-Forwarded-For move.
		if (!fromLoopback(request)) {
			const body: ApiError = { code: "FORBIDDEN", message: "Forbidden." };
			await reply.status(403).send(body);
			return;
		}
		// Caddy has already matched the decoded path, so every ask counts;
		// matching the raw URI again here let encoded paths by. Caddy sets
		// scope=start for Dex's sign-in pages, which each store a request. The
		// password post goes through the relay instead; any other ask still
		// counts as a password, so no scope escapes counting.
		// request.ip is the client Caddy named in X-Forwarded-For.
		const { scope } = request.query as { scope?: string };
		const decision =
			scope === "start"
				? throttle.checkStart(request.ip)
				: throttle.checkPassword(request.ip);
		if (!decision.allowed) {
			await refuse(
				request,
				reply,
				decision,
				scope === "start" ? "signin-start" : "password",
			);
			return;
		}
		await reply.status(204).send();
	});
	return throttle;
}

/** The edge route itself; the hook above always answers it first. */
export function registerSigninThrottleRoute(app: FastifyInstance): void {
	app.get(EDGE_THROTTLE_PATH, async (_request, reply) => reply.status(204).send());
}

/**
 * Wrong answers from one account: ten in ten minutes, for current
 * passwords on the change form (SPEC.md section 5.3) and second-factor
 * codes (section 24.13). Each try is counted before it is checked, so
 * parallel requests cannot slip past the limit, and handed back when it
 * was not wrong. Per account, not per address, so a lab behind one
 * address is not blocked together.
 */
export function createAccountThrottle(now: () => number = Date.now) {
	const attempts = createCounter(10, TEN_MINUTES_MS, now);
	return {
		/** Count one try for this account; refused once the limit is used up. */
		attempt(userId: string): ThrottleDecision {
			const window = attempts.hit(userId);
			return decide(window, window.count > attempts.limit);
		},
		/** Give back a try that turned out not to be a wrong password. */
		giveBack(userId: string): void {
			const window = attempts.peek(userId);
			if (window.count > 0) window.count -= 1;
		},
	};
}
