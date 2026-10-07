import type { ApiError } from "@portikus/contracts";
import { type Database, recordAudit, recordNotification } from "@portikus/db";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Kysely } from "kysely";
import { createCounter } from "./rate-limit.js";

/**
 * Wrong second-factor codes per account (SPEC.md section 24.13), counted
 * once for every route that checks a code, so a password holder gets one
 * allowance, not one per route. Counts live in this process, which the
 * pilot runs one of.
 */

const TEN_MINUTES_MS = 10 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
const SECOND_FACTOR_LIMIT_PER_10_MINUTES = 10;
export const SECOND_FACTOR_DAILY_LIMIT = 30;

export interface SecondFactorDecision {
	allowed: boolean;
	/** True for the first refusal of this account in its window. */
	audit: boolean;
	/** True when the daily cap, not the ten-minute one, refused it. */
	daily: boolean;
	/** Present only when the try was counted, so only it can be given back. */
	receipt: SecondFactorReceipt | null;
}

/** One counted hit on one counter: which count, whose, and in which window. */
interface CounterReceipt {
	scope: "second-factor" | "second-factor-daily";
	key: string;
	windowStart: number;
}

/** Proof that one request's try was counted, so a give-back returns only its own count. */
export interface SecondFactorReceipt {
	readonly hits: readonly CounterReceipt[];
	spent: boolean;
}

/** The counting alone, apart from audit and notice, so it can be tested with a clock. */
// Read the clock on every call, so a test that fakes Date is seen.
export function createSecondFactorCounts(now: () => number = () => Date.now()) {
	const short = createCounter(SECOND_FACTOR_LIMIT_PER_10_MINUTES, TEN_MINUTES_MS, now);
	const daily = createCounter(SECOND_FACTOR_DAILY_LIMIT, DAY_MS, now);
	return {
		/** Count one try before it is checked, so parallel tries cannot slip past. */
		attempt(userId: string): SecondFactorDecision {
			const window = short.hit(userId);
			if (window.count > short.limit) {
				const audit = !window.reported;
				window.reported = true;
				return { allowed: false, audit, daily: false, receipt: null };
			}
			// Only tries that reach the check count toward the day.
			const day = daily.hit(userId);
			if (day.count > daily.limit) {
				window.count -= 1;
				day.count -= 1;
				const audit = !day.reported;
				day.reported = true;
				return { allowed: false, audit, daily: true, receipt: null };
			}
			const receipt: SecondFactorReceipt = {
				hits: [
					{ scope: "second-factor", key: userId, windowStart: window.startedAt },
					{ scope: "second-factor-daily", key: userId, windowStart: day.startedAt },
				],
				spent: false,
			};
			return { allowed: true, audit: false, daily: false, receipt };
		},
		/**
		 * Give back a counted try that was a right code or never reached the
		 * check. Does nothing once spent, or in a window that has since ended.
		 */
		giveBack(receipt: SecondFactorReceipt): void {
			if (receipt.spent) return;
			receipt.spent = true;
			for (const hit of receipt.hits) {
				const counter = hit.scope === "second-factor" ? short : daily;
				const window = counter.peek(hit.key);
				if (window.startedAt === hit.windowStart && window.count > 0) window.count -= 1;
			}
		},
	};
}

export type SecondFactorThrottle = ReturnType<typeof createSecondFactorThrottle>;

/** One per server; buildServer hands it to every route that checks a code. */
export function createSecondFactorThrottle(db: Kysely<Database>) {
	const counts = createSecondFactorCounts();
	return {
		/**
		 * Count one try for this account. On a refusal the 429 is sent, the
		 * first refusal is audited, and the first daily-cap refusal leaves the
		 * holder a kept notice. Returns the try's receipt, or null when refused.
		 */
		async allow(
			request: FastifyRequest,
			reply: FastifyReply,
			userId: string,
		): Promise<SecondFactorReceipt | null> {
			const decision = counts.attempt(userId);
			if (decision.receipt) return decision.receipt;
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
						body: "Someone entered many wrong two-step sign-in codes for your account today. If this was not you, tell your administrator.",
					},
					{ kept: true },
				);
			}
			const body: ApiError = {
				code: "RATE_LIMITED",
				message: decision.daily
					? "Too many wrong codes today. Please try again later."
					: "Too many wrong codes. Please wait a few minutes and try again.",
			};
			await reply.status(429).send(body);
			return null;
		},
		giveBack: counts.giveBack,
	};
}
