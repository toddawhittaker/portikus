import { randomBytes } from "node:crypto";
import { findPlatform, type LtiPlatform } from "./platforms.js";

/** The third-party login initiation parameters (GET query or POST form). */
export interface LtiLoginParams {
	iss?: string;
	login_hint?: string;
	target_link_uri?: string;
	lti_message_hint?: string;
	client_id?: string;
	lti_deployment_id?: string;
}

/** Why `/lti/login` answers 400. */
export type LtiLoginRefusal = "unknown_issuer" | "missing_login_hint" | "wrong_target";

export type LtiLoginResult =
	| {
			ok: true;
			platform: LtiPlatform;
			/** Goes in the state row (hashed) and the state cookie. */
			state: string;
			/** Goes in the state row. */
			nonce: string;
			/** Where to send the browser: the platform's authorization endpoint. */
			redirectUrl: string;
	  }
	| { ok: false; reason: LtiLoginRefusal };

/** True when `uri` parses and is on `publicUrl`'s origin. */
export function isOnOrigin(uri: string, publicUrl: string): boolean {
	try {
		return new URL(uri).origin === new URL(publicUrl).origin;
	} catch {
		return false;
	}
}

/**
 * Check a login initiation and build the authorization request
 * (docs/EPIC-13.md ruling 19 and "Validation reference"). The caller stores
 * the state with `saveLoginState`, sets the state cookie, and redirects.
 * An unknown issuer and client id pair, or an issuer with several
 * registrations and no client id, is `unknown_issuer`.
 */
export function startLtiLogin(
	platforms: readonly LtiPlatform[],
	publicUrl: string,
	params: LtiLoginParams,
): LtiLoginResult {
	if (!params.iss) return { ok: false, reason: "unknown_issuer" };
	const platform = findPlatform(platforms, params.iss, params.client_id || undefined);
	if (!platform) return { ok: false, reason: "unknown_issuer" };
	if (!params.login_hint) return { ok: false, reason: "missing_login_hint" };
	if (!params.target_link_uri || !isOnOrigin(params.target_link_uri, publicUrl)) {
		return { ok: false, reason: "wrong_target" };
	}

	const state = randomBytes(32).toString("base64url");
	const nonce = randomBytes(32).toString("base64url");
	const url = new URL(platform.authLoginUrl);
	const query: Record<string, string> = {
		scope: "openid",
		response_type: "id_token",
		response_mode: "form_post",
		prompt: "none",
		client_id: platform.clientId,
		redirect_uri: new URL("/lti/launch", publicUrl).toString(),
		login_hint: params.login_hint,
		state,
		nonce,
	};
	if (params.lti_message_hint) query.lti_message_hint = params.lti_message_hint;
	for (const [key, value] of Object.entries(query)) {
		url.searchParams.set(key, value);
	}
	return { ok: true, platform, state, nonce, redirectUrl: url.toString() };
}
