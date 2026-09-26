import type { ApiConfig } from "@portikus/config";
import type { ApiError } from "@portikus/contracts";
import type { Database } from "@portikus/db";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Kysely } from "kysely";
import { createCounter, type Window } from "./rate-limit.js";

/**
 * The sign-in rate limit (issue #398; docs/archive/epics/EPIC-12B.md, "Sign-in rate
 * limit"). Counts live in this process, which the pilot runs one of.
 */

const MINUTE_MS = 60_000;
const TEN_MINUTES_MS = 10 * MINUTE_MS;
/** The overall password limit is this many times the per-address one. */
const PASSWORD_TOTAL_FACTOR = 10;
/** The path Caddy asks about for Dex's sign-in pages and password form. */
export const EDGE_THROTTLE_PATH = "/edge/signin-throttle";
// An LTI launch is a sign-in start too (docs/archive/epics/EPIC-13.md ruling 21).
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
	const allPasswords = createCounter(
		options.passwordLimitPer10Minutes * PASSWORD_TOTAL_FACTOR,
		TEN_MINUTES_MS,
		now,
	);

	return {
		checkStart(ip: string): ThrottleDecision {
			const window = starts.hit(ip);
			return decide(window, window.count > starts.limit);
		},
		checkPassword(ip: string): ThrottleDecision {
			const window = passwords.hit(ip);
			if (window.count > passwords.limit) return decide(window, true);
			// Only attempts the address limit let through count class-wide, so
			// one address cannot use up everyone's allowance.
			const total = allPasswords.hit("all");
			return decide(window, total.count > allPasswords.limit);
		},
	};
}

function fromLoopback(request: FastifyRequest): boolean {
	const address = request.raw.socket.remoteAddress ?? "";
	return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

/**
 * Count sign-in starts and Dex password posts before the auth hook runs, so
 * the edge check needs no session. Call before registering the auth plugin.
 */
export function registerSigninThrottle(
	app: FastifyInstance,
	deps: { db: Kysely<Database>; config: ApiConfig },
): void {
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
				await deps.db
					.insertInto("audit_events")
					.values({
						actor: "unknown",
						target: "unknown",
						action: "auth.throttled",
						result: "denied",
						metadata: JSON.stringify({ ip: request.ip, scope }),
					})
					.execute();
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
		// scope=start for Dex's sign-in pages, which each store a request, and
		// scope=password for the password post; anything else counts as a password.
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
}

/** The edge route itself; the hook above always answers it first. */
export function registerSigninThrottleRoute(app: FastifyInstance): void {
	app.get(EDGE_THROTTLE_PATH, async (_request, reply) => reply.status(204).send());
}

/**
 * Wrong current passwords on the change form: ten per account in ten
 * minutes (SPEC.md section 5.3; Todd's ruling of 2026-09-25). Each try is
 * counted before Dex is asked, so parallel requests cannot slip past the
 * limit, and handed back when it was not a wrong password.
 */
export function createPasswordChangeThrottle(now: () => number = Date.now) {
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
