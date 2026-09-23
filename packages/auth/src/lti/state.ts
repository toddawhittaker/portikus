import { createHash, timingSafeEqual } from "node:crypto";
import type { CookieSerializeOptions } from "@fastify/cookie";
import type { Kysely } from "kysely";

/**
 * The one table this module touches, as migration 0015_lti defines it
 * (docs/EPIC-13.md, "The data model"). Declared here so the store does not
 * depend on the db package's schema.
 */
export interface LtiLoginStatesTable {
	lti_login_states: {
		state_hash: string;
		nonce: string;
		platform_issuer: string;
		client_id: string;
		expires_at: Date;
	};
}

/** What a consumed state row gives back to the launch. */
export interface LtiLoginState {
	nonce: string;
	platformIssuer: string;
	clientId: string;
}

/** How long a login may take between `/lti/login` and `/lti/launch` (ruling 16). */
export const LTI_STATE_TTL_SECONDS = 600;

const STATE_COOKIE = "portikus_lti_state";

/** The row key: the state itself is never stored. */
export function hashState(state: string): string {
	return createHash("sha256").update(state).digest("hex");
}

/** Store a new login state, clearing expired rows first as sessions do. */
export async function saveLoginState<DB extends LtiLoginStatesTable>(
	database: Kysely<DB>,
	input: { state: string; nonce: string; platformIssuer: string; clientId: string },
	now: Date = new Date(),
): Promise<void> {
	const db = database as unknown as Kysely<LtiLoginStatesTable>;
	await db.deleteFrom("lti_login_states").where("expires_at", "<=", now).execute();
	await db
		.insertInto("lti_login_states")
		.values({
			state_hash: hashState(input.state),
			nonce: input.nonce,
			platform_issuer: input.platformIssuer,
			client_id: input.clientId,
			expires_at: new Date(now.getTime() + LTI_STATE_TTL_SECONDS * 1000),
		})
		.execute();
}

/**
 * Delete the state's row and return it, or null when there is no unexpired
 * row. One DELETE ... RETURNING, so two launches with the same state cannot
 * both succeed: the state and its nonce are single use. Pass the launch's
 * transaction to tie the delete to the rest of the launch.
 */
export async function consumeLoginState<DB extends LtiLoginStatesTable>(
	database: Kysely<DB>,
	state: string,
	now: Date = new Date(),
): Promise<LtiLoginState | null> {
	const db = database as unknown as Kysely<LtiLoginStatesTable>;
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

function isSecure(publicUrl: string): boolean {
	return publicUrl.startsWith("https:");
}

/** `__Secure-portikus_lti_state` over https, the bare name on plain http (ruling 16). */
export function ltiStateCookieName(publicUrl: string): string {
	return isSecure(publicUrl) ? `__Secure-${STATE_COOKIE}` : STATE_COOKIE;
}

/**
 * SameSite=None over https, because the platform's form post is a
 * cross-site top-level POST; Lax on plain-http development sites (ruling 16).
 */
export function ltiStateCookieOptions(publicUrl: string): CookieSerializeOptions {
	const secure = isSecure(publicUrl);
	return {
		httpOnly: true,
		secure,
		sameSite: secure ? "none" : "lax",
		path: "/lti",
		maxAge: LTI_STATE_TTL_SECONDS,
	};
}
