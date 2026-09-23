import { createHash, timingSafeEqual } from "node:crypto";
import type { CookieSerializeOptions } from "@fastify/cookie";
import type { Database } from "@portikus/db";
import type { Kysely } from "kysely";

/** What a consumed state row gives back to the launch. */
export interface LtiLoginState {
	nonce: string;
	platformIssuer: string;
	clientId: string;
}

/** How long a login may take between `/lti/login` and `/lti/launch` (ruling 16). */
export const LTI_STATE_TTL_SECONDS = 600;

const STATE_COOKIE_PREFIX = "__Host-portikus_lti_state_";

/** The row key: the state itself is never stored. */
export function hashState(state: string): string {
	return createHash("sha256").update(state).digest("hex");
}

/** Store a new login state, clearing expired rows first as sessions do. */
export async function saveLoginState(
	db: Kysely<Database>,
	input: { state: string; nonce: string; platformIssuer: string; clientId: string },
	now: Date = new Date(),
): Promise<void> {
	await db.deleteFrom("lti_login_states").where("expires_at", "<=", now).execute();
	await db
		.insertInto("lti_login_states")
		.values({
			state_hash: hashState(input.state),
			nonce: input.nonce,
			platform_issuer: input.platformIssuer,
			client_id: input.clientId,
			expires_at: new Date(now.getTime() + LTI_STATE_TTL_SECONDS * 1000).toISOString(),
		})
		.execute();
}

/**
 * Delete the state's row and return it, or null when there is no unexpired
 * row. One DELETE ... RETURNING, so two launches with the same state cannot
 * both succeed: the state and its nonce are single use. The launch runs
 * this delete first, so no transaction spans the keyset fetch.
 */
export async function consumeLoginState(
	db: Kysely<Database>,
	state: string,
	now: Date = new Date(),
): Promise<LtiLoginState | null> {
	const row = await db
		.deleteFrom("lti_login_states")
		.where("state_hash", "=", hashState(state))
		.where("expires_at", ">", now)
		.returning(["nonce", "platform_issuer", "client_id"])
		.executeTakeFirst();
	if (!row) return null;
	return {
		nonce: row.nonce,
		platformIssuer: row.platform_issuer,
		clientId: row.client_id,
	};
}

/**
 * The form's state must equal the cookie's (ruling 16). A missing cookie or
 * form field is `state_missing`; two different values are `state_mismatch`.
 */
export function checkLaunchState(
	formState: string | undefined,
	cookieState: string | undefined,
): "state_missing" | "state_mismatch" | null {
	if (!formState || !cookieState) return "state_missing";
	const a = Buffer.from(formState);
	const b = Buffer.from(cookieState);
	if (a.length !== b.length || !timingSafeEqual(a, b)) return "state_mismatch";
	return null;
}

/**
 * One cookie per login, named from the state's hash, so two launches in
 * flight at once do not overwrite each other's cookie. `__Host-` pins it to
 * this host with Path=/ and Secure (security review #3).
 */
export function ltiStateCookieName(state: string): string {
	return STATE_COOKIE_PREFIX + hashState(state).slice(0, 16);
}

/**
 * SameSite=None because the platform's form post is a cross-site top-level
 * POST. Browsers accept Secure cookies on http://localhost, so development
 * needs no exception.
 */
export function ltiStateCookieOptions(): CookieSerializeOptions {
	return {
		httpOnly: true,
		secure: true,
		sameSite: "none",
		path: "/",
		maxAge: LTI_STATE_TTL_SECONDS,
	};
}

/** At most this many older state cookies survive a new login. */
export const LTI_STATE_COOKIES_KEPT = 4;

/**
 * Names of the oldest state cookies to clear so at most
 * LTI_STATE_COOKIES_KEPT remain besides a new one; header order stands in
 * for age, since browsers send older cookies first.
 */
export function staleLtiStateCookies(
	cookies: Record<string, string | undefined>,
): string[] {
	const names = Object.keys(cookies).filter((name) =>
		name.startsWith(STATE_COOKIE_PREFIX),
	);
	return names.slice(0, Math.max(0, names.length - LTI_STATE_COOKIES_KEPT));
}

/** The state cookie belonging to this form's state, if the browser sent it. */
export function readLtiStateCookie(
	cookies: Record<string, string | undefined>,
	formState: string,
): string | undefined {
	return cookies[ltiStateCookieName(formState)];
}
