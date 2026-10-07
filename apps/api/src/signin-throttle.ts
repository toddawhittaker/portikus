import type { ApiConfig } from "@portikus/config";
import type { ApiError } from "@portikus/contracts";
import { type Database, recordAudit } from "@portikus/db";
import type { Logger } from "@portikus/observability";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Kysely } from "kysely";
import { fromLoopback } from "./loopback.js";
import { addressKey, createCounter, type Window } from "./rate-limit.js";
import {
	type CounterReceipt,
	createStoredCounter,
	type StoredCounter,
	type StoredDecision,
} from "./stored-counter.js";

/**
 * The sign-in rate limit (SPEC.md sections 5.3 and 24.13). Sign-in starts
 * are counted in this process; password guesses in PostgreSQL, so a restart
 * hands out no fresh guesses (ADR 0053).
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

/** Dex compares logins without case, so the count does too. */
export function accountKey(login: string): string {
	return login.trim().toLowerCase();
}

export type SigninThrottle = ReturnType<typeof createSigninThrottle>;

export function createSigninThrottle(options: {
	db: Kysely<Database>;
	logger: Logger;
	startLimitPerMinute: number;
	passwordLimitPer10Minutes: number;
	now?: () => number;
}) {
	const now = options.now ?? (() => Date.now());
	const starts = createCounter(options.startLimitPerMinute, MINUTE_MS, now);
	const stored = {
		db: options.db,
		logger: options.logger,
		windowMs: TEN_MINUTES_MS,
		now,
	};
	const passwords = createStoredCounter({
		...stored,
		scope: "password",
		limit: options.passwordLimitPer10Minutes,
	});
	const accountFailures = createStoredCounter({
		...stored,
		scope: "password-account",
		limit: ACCOUNT_FAILURE_LIMIT,
	});

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
		passwordAttempt(ip: string): Promise<StoredDecision> {
			return passwords.attempt(addressKey(ip));
		},
		/** Count one try against this account before it reaches Dex. */
		accountAttempt(login: string): Promise<StoredDecision> {
			return accountFailures.attempt(accountKey(login));
		},
		/** Count a wrong password from a known browser, which skipped accountAttempt. */
		accountFailed(login: string): Promise<void> {
			return accountFailures.add(accountKey(login));
		},
		/**
		 * Give back a post that was not a wrong password, so a shared address
		 * or an account is not locked out by right ones.
		 */
		giveBack(receipt: CounterReceipt): Promise<void> {
			const counter = receipt.scope === passwords.scope ? passwords : accountFailures;
			return counter.giveBack(receipt);
		},
	};
}

/**
 * Count sign-in starts before the auth hook runs. The edge check only
 * confirms Caddy asked; the anonymous request limit already counted it. Call before registering the auth plugin.
 */
export function registerSigninThrottle(
	app: FastifyInstance,
	deps: { db: Kysely<Database>; config: ApiConfig; logger: Logger },
): SigninThrottle {
	const throttle = createSigninThrottle({
		db: deps.db,
		logger: deps.logger,
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
 * minutes (SPEC.md section 5.3), kept in PostgreSQL (ADR 0053). Second-factor
 * codes have their own count in second-factor-throttle.ts. Each try is
 * counted before it is checked, so parallel requests cannot slip past the
 * limit, and its receipt is handed back when it was not wrong. Per account,
 * not per address, so a lab behind one address is not blocked together.
 */
export function createAccountThrottle(options: {
	db: Kysely<Database>;
	logger: Logger;
	now?: () => number;
}): StoredCounter {
	return createStoredCounter({
		...options,
		scope: "password-change",
		limit: ACCOUNT_FAILURE_LIMIT,
		windowMs: TEN_MINUTES_MS,
	});
}
