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
// Each sign-in begins at exactly one of these, so a start is counted once.
// The callback, the LTI launch and Dex's own pages are bounded by the
// anonymous request limit instead (SPEC.md section 24.13).
const START_ROUTES = new Set(["/auth/login", "/lti/login"]);

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

function giveBack(window: Window): void {
	if (window.count > 0) window.count -= 1;
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
		/**
		 * Count one password post from this address before it reaches Dex,
		 * so parallel posts cannot slip past the limit.
		 */
		passwordAttempt(ip: string): ThrottleDecision {
			const window = passwords.hit(addressKey(ip));
			return decide(window, window.count > passwords.limit);
		},
		/** Give back a post that was not a wrong password, so a shared address is not locked out by right ones. */
		passwordGiveBack(ip: string): void {
			giveBack(passwords.peek(addressKey(ip)));
		},
		/** Count one try against this account before it reaches Dex. */
		accountAttempt(login: string): ThrottleDecision {
			const window = accountFailures.hit(accountKey(login));
			return decide(window, window.count > accountFailures.limit);
		},
		/** Give back a try that turned out not to be a wrong password. */
		accountGiveBack(login: string): void {
			giveBack(accountFailures.peek(accountKey(login)));
		},
		/** Count a wrong password from a known browser, which skipped accountAttempt. */
		accountFailed(login: string): void {
			accountFailures.hit(accountKey(login));
		},
	};
}

/**
 * Count sign-in starts before the auth hook runs. The edge check only
 * confirms Caddy asked; the anonymous request limit already counted it. Call before registering the auth plugin.
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
	): Promise<void> {
		if (decision.audit) {
			try {
				await recordAudit(deps.db, {
					actor: "unknown",
					target: "unknown",
					action: "auth.throttled",
					result: "denied",
					metadata: { ip: request.ip, scope: "signin-start" },
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
			if (!decision.allowed) await refuse(request, reply, decision);
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
		await reply.status(204).send();
	});
	return throttle;
}

/** The edge route itself; the hook above always answers it first. */
export function registerSigninThrottleRoute(app: FastifyInstance): void {
	app.get(EDGE_THROTTLE_PATH, async (_request, reply) => reply.status(204).send());
}

/**
 * Wrong current passwords on the change form from one account: ten in ten
 * minutes (SPEC.md section 5.3). Second-factor codes have their own count
 * in second-factor-throttle.ts. Each try is counted before it is checked, so
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
			giveBack(attempts.peek(userId));
		},
	};
}
