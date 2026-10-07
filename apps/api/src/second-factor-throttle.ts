import type { ApiError } from "@portikus/contracts";
import { type Database, recordAudit, recordNotification } from "@portikus/db";
import type { Logger } from "@portikus/observability";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Kysely } from "kysely";
import { check, createCounter } from "./rate-limit.js";
import { type CounterReceipt, createStoredCounter } from "./stored-counter.js";

/**
 * Wrong second-factor codes per account (SPEC.md section 24.13), counted
 * once for every route that checks a code, so a password holder gets one
 * allowance, not one per route. The counts live in PostgreSQL (ADR 0053).
 */

const TEN_MINUTES_MS = 10 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
const SECOND_FACTOR_LIMIT_PER_10_MINUTES = 10;
export const SECOND_FACTOR_DAILY_LIMIT = 30;
/** Recovery-code and passkey tries one session may make once the account's count refuses. */
const BYPASS_LIMIT_PER_10_MINUTES = 10;

export interface SecondFactorDecision {
	allowed: boolean;
	/** True for the first refusal of this account in its window. */
	audit: boolean;
	/** True when the daily cap, not the ten-minute one, refused it. */
	daily: boolean;
	/** Present only when the try was counted, so only it can be given back. */
	receipt: SecondFactorReceipt | null;
}

/** Proof that one request's try was counted on both counts. */
export interface SecondFactorReceipt {
	readonly short: CounterReceipt;
	readonly daily: CounterReceipt;
}

/** The counting alone, apart from audit and notice, so it can be tested with a clock. */
export function createSecondFactorCounts(options: {
	db: Kysely<Database>;
	logger: Logger;
	// Read the clock on every call, so a test that fakes Date is seen.
	now?: () => number;
}) {
	const shared = {
		db: options.db,
		logger: options.logger,
		now: options.now ?? (() => Date.now()),
	};
	const short = createStoredCounter({
		...shared,
		scope: "second-factor",
		limit: SECOND_FACTOR_LIMIT_PER_10_MINUTES,
		windowMs: TEN_MINUTES_MS,
	});
	const daily = createStoredCounter({
		...shared,
		scope: "second-factor-daily",
		limit: SECOND_FACTOR_DAILY_LIMIT,
		windowMs: DAY_MS,
	});
	return {
		/** Count one try before it is checked, so parallel tries cannot slip past. */
		async attempt(userId: string): Promise<SecondFactorDecision> {
			const window = await short.attempt(userId);
			if (!window.receipt) {
				return { allowed: false, audit: window.audit, daily: false, receipt: null };
			}
			// Only tries that reach the check count toward the day.
			const day = await daily.attempt(userId);
			if (!day.receipt) {
				// The day refused it before any check, so the ten minutes get it back.
				await short.giveBack(window.receipt);
				return { allowed: false, audit: day.audit, daily: true, receipt: null };
			}
			const receipt = { short: window.receipt, daily: day.receipt };
			return { allowed: true, audit: false, daily: false, receipt };
		},
		/**
		 * Give back a counted try that was a right code or never reached the
		 * check. Does nothing once spent, or in a window that has since ended.
		 */
		async giveBack(receipt: SecondFactorReceipt): Promise<void> {
			await short.giveBack(receipt.short);
			await daily.giveBack(receipt.daily);
		},
	};
}

/** How a try may go on to its check. */
export type SecondFactorAllowance =
	| { kind: "counted"; receipt: SecondFactorReceipt }
	/** The account's count refused, but a recovery code or passkey still gets a check (ADR 0053). */
	| { kind: "bypass" };

export interface BypassRequest {
	/** The session's id; bypass tries count per session, so others cannot use up the holder's. */
	sessionId: string;
	/** True for a recovery code or a passkey, the only tries that may pass a refused count. */
	eligible: boolean;
	/** Whether this route takes passkeys, so the refusal names only what works here. */
	passkeys: boolean;
}

function refusalMessage(daily: boolean, passkeys: boolean): string {
	const other = passkeys ? "a recovery code or a passkey" : "a recovery code";
	return daily
		? `Too many wrong codes today. You can still sign in with ${other}.`
		: `Too many wrong codes. Wait a few minutes, or use ${other}.`;
}

export type SecondFactorThrottle = ReturnType<typeof createSecondFactorThrottle>;

/** One per server; buildServer hands it to every route that checks a code. */
export function createSecondFactorThrottle(db: Kysely<Database>, logger: Logger) {
	// Read the clock on every call, so a test that fakes Date is seen.
	const now = () => Date.now();
	const counts = createSecondFactorCounts({ db, logger, now });
	// In memory: losing these on a restart only means a retry (ADR 0053).
	const bypassTries = createCounter(BYPASS_LIMIT_PER_10_MINUTES, TEN_MINUTES_MS, now);
	return {
		/**
		 * Count one try for this account. On a refusal the 429 is sent, the
		 * first refusal is audited, and the first daily-cap refusal leaves the
		 * holder a kept notice. A refused recovery code or passkey still goes
		 * on, counted per session and with no receipt. Returns null when
		 * refused.
		 */
		async allow(
			request: FastifyRequest,
			reply: FastifyReply,
			userId: string,
			bypass: BypassRequest,
		): Promise<SecondFactorAllowance | null> {
			const decision = await counts.attempt(userId);
			if (decision.receipt) return { kind: "counted", receipt: decision.receipt };
			if (decision.audit) {
				await recordAudit(db, {
					actor: `user:${userId}`,
					target: userId,
					action: "auth.throttled",
					result: "denied",
					metadata: {
						ip: request.ip,
						scope: decision.daily ? "second-factor-daily" : "second-factor",
					},
				});
			}
			// Once a day: the daily window audits only its first refusal.
			if (decision.daily && decision.audit) {
				await recordNotification(
					db,
					userId,
					{
						tone: "warning",
						title: "Many wrong two-step sign-in codes",
						body: "Someone entered many wrong two-step sign-in codes for your account today. If this was not you, they know your password: change it in Settings now, and tell your administrator.",
					},
					{ kept: true },
				);
			}
			if (bypass.eligible) {
				const tries = check(bypassTries, bypass.sessionId);
				if (tries.allowed) return { kind: "bypass" };
				if (tries.firstRefusal) {
					request.log.warn(
						{ userId },
						"second-factor bypass limit reached for a session",
					);
				}
				const body: ApiError = {
					code: "RATE_LIMITED",
					message: "Too many tries. Please wait a few minutes and try again.",
				};
				await reply
					.status(429)
					.header("retry-after", String(tries.retryAfterSeconds))
					.send(body);
				return null;
			}
			const body: ApiError = {
				code: "RATE_LIMITED",
				message: refusalMessage(decision.daily, bypass.passkeys),
			};
			await reply.status(429).send(body);
			return null;
		},
		giveBack: counts.giveBack,
	};
}
