import {
	compactVerify,
	createRemoteJWKSet,
	customFetch,
	decodeProtectedHeader,
	errors,
	type JWTVerifyGetKey,
} from "jose";
import { createOutboundFetch } from "../outbound-fetch.js";
import { isOnOrigin } from "./login.js";
import type { LtiPlatform } from "./platforms.js";
import { type LtiRole, mapLtiRoles } from "./roles.js";
import type { LtiLoginState } from "./state.js";

/**
 * Every reason a launch is refused, one per check (docs/archive/epics/EPIC-13.md ruling
 * 19). `state_missing` and `state_mismatch` come from `checkLaunchState`
 * and `consumeLoginState`; the rest from {@link validateLaunchToken}.
 */
export type LtiRefusal =
	| "state_missing"
	| "state_mismatch"
	| "alg_not_allowed"
	| "bad_signature"
	| "keyset_unavailable"
	| "unknown_issuer"
	| "wrong_audience"
	| "expired"
	| "issued_in_future"
	| "nonce_mismatch"
	| "unknown_deployment"
	| "wrong_message_type"
	| "wrong_version"
	| "wrong_target"
	| "missing_subject"
	| "missing_resource_link"
	| "bad_context";

/** What a valid launch says about the person and the course. No token or raw claims. */
export interface LtiLaunch {
	platform: LtiPlatform;
	subject: string;
	/** `name`, else given and family name, else "LTI user" (ruling 20). */
	displayName: string;
	/** For the profile only; never used to find or link an account. */
	email: string | null;
	/** `preferred_username`, else the custom claim `username`; names the workspace (SPEC.md, Epic 8). */
	username: string | null;
	role: LtiRole;
	/** Absent when the launch had no context claim: sign in, record no membership. */
	context: { id: string; title: string } | null;
	targetLinkUri: string;
}

export type LtiLaunchResult =
	| { ok: true; launch: LtiLaunch }
	| { ok: false; reason: LtiRefusal; platform: LtiPlatform | null };

/** Returns the key-lookup function for a keyset URL, cached per URL. */
export type KeySetSource = (keysetUrl: string) => JWTVerifyGetKey;

const CLAIM = "https://purl.imsglobal.org/spec/lti/claim/";
const CLOCK_SKEW_SECONDS = 60;

/**
 * One remote JWKS per keyset URL, kept for the life of the process: keys
 * cached 10 minutes, an unknown `kid` refetches at most every 30 seconds,
 * each fetch times out after 5 seconds (ruling 19). With a proxy URL the
 * fetches go through the forward proxy (docs/archive/epics/EPIC-14.md ruling 27).
 */
export function createKeySetSource(proxyUrl?: string | null): KeySetSource {
	const outboundFetch = createOutboundFetch(proxyUrl);
	const sets = new Map<string, JWTVerifyGetKey>();
	return (keysetUrl) => {
		let set = sets.get(keysetUrl);
		if (!set) {
			set = createRemoteJWKSet(new URL(keysetUrl), {
				cacheMaxAge: 600_000,
				cooldownDuration: 30_000,
				timeoutDuration: 5_000,
				[customFetch]: outboundFetch,
			});
			sets.set(keysetUrl, set);
		}
		return set;
	};
}

export interface ValidateLaunchInput {
	/** The `id_token` form field. Never log it. */
	idToken: string;
	/** The row `consumeLoginState` returned for this launch's state. */
	loginState: LtiLoginState;
	platforms: readonly LtiPlatform[];
	publicUrl: string;
	keySets: KeySetSource;
	now?: Date;
}

function isString(value: unknown): value is string {
	return typeof value === "string";
}

function objectClaim(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function displayNameOf(claims: Record<string, unknown>): string {
	if (isString(claims.name) && claims.name.trim() !== "") return claims.name.trim();
	const parts = [claims.given_name, claims.family_name]
		.filter(isString)
		.map((p) => p.trim())
		.filter((p) => p !== "");
	return parts.length > 0 ? parts.join(" ") : "LTI user";
}

/** LTI 1.3 has no username claim, so an LMS may send one as a custom parameter. */
function usernameOf(claims: Record<string, unknown>): string | null {
	const custom = objectClaim(claims[`${CLAIM}custom`]);
	for (const value of [claims.preferred_username, custom?.username]) {
		if (isString(value) && value.trim() !== "") return value.trim();
	}
	return null;
}

/**
 * Check a launch's id_token against the login it answers. The signature is
 * checked (RS256 only, against the registration's keyset) before any claim
 * is trusted; every refusal carries one reason code.
 */
export async function validateLaunchToken(
	input: ValidateLaunchInput,
): Promise<LtiLaunchResult> {
	const { loginState } = input;
	const platform =
		input.platforms.find(
			(p) =>
				p.issuer === loginState.platformIssuer && p.clientId === loginState.clientId,
		) ?? null;
	const refuse = (reason: LtiRefusal): LtiLaunchResult => ({
		ok: false,
		reason,
		platform,
	});

	let alg: unknown;
	try {
		alg = decodeProtectedHeader(input.idToken).alg;
	} catch {
		return refuse("bad_signature");
	}
	if (alg !== "RS256") return refuse("alg_not_allowed");
	if (!platform) return refuse("unknown_issuer");

	let claims: Record<string, unknown>;
	try {
		const { payload } = await compactVerify(
			input.idToken,
			input.keySets(platform.keysetUrl),
			{ algorithms: ["RS256"] },
		);
		const parsed = objectClaim(JSON.parse(new TextDecoder().decode(payload)));
		if (!parsed) return refuse("bad_signature");
		claims = parsed;
	} catch (error) {
		if (
			error instanceof errors.JWSSignatureVerificationFailed ||
			error instanceof errors.JWKSNoMatchingKey ||
			error instanceof errors.JWSInvalid ||
			error instanceof SyntaxError
		) {
			return refuse("bad_signature");
		}
		return refuse("keyset_unavailable");
	}

	// The login started with this platform, so the token must come from it.
	if (claims.iss !== platform.issuer) return refuse("unknown_issuer");

	const aud = claims.aud;
	if (Array.isArray(aud)) {
		if (!aud.includes(platform.clientId)) return refuse("wrong_audience");
		if (aud.length > 1 && claims.azp !== platform.clientId) {
			return refuse("wrong_audience");
		}
	} else if (aud !== platform.clientId) {
		return refuse("wrong_audience");
	}

	const nowSeconds = Math.floor((input.now ?? new Date()).getTime() / 1000);
	if (typeof claims.exp !== "number" || claims.exp + CLOCK_SKEW_SECONDS <= nowSeconds) {
		return refuse("expired");
	}
	if (typeof claims.iat !== "number" || claims.iat - CLOCK_SKEW_SECONDS > nowSeconds) {
		return refuse("issued_in_future");
	}

	if (claims.nonce !== loginState.nonce) return refuse("nonce_mismatch");

	const deploymentId = claims[`${CLAIM}deployment_id`];
	if (!isString(deploymentId) || !platform.deploymentIds.includes(deploymentId)) {
		return refuse("unknown_deployment");
	}
	if (claims[`${CLAIM}message_type`] !== "LtiResourceLinkRequest") {
		return refuse("wrong_message_type");
	}
	if (claims[`${CLAIM}version`] !== "1.3.0") return refuse("wrong_version");

	const target = claims[`${CLAIM}target_link_uri`];
	if (!isString(target) || !isOnOrigin(target, input.publicUrl)) {
		return refuse("wrong_target");
	}

	const sub = claims.sub;
	if (!isString(sub) || sub.length < 1 || sub.length > 255) {
		return refuse("missing_subject");
	}

	const resourceLink = objectClaim(claims[`${CLAIM}resource_link`]);
	if (!resourceLink || !isString(resourceLink.id) || resourceLink.id === "") {
		return refuse("missing_resource_link");
	}

	let context: LtiLaunch["context"] = null;
	const rawContext = claims[`${CLAIM}context`];
	if (rawContext !== undefined) {
		const ctx = objectClaim(rawContext);
		if (!ctx || !isString(ctx.id) || ctx.id.length < 1 || ctx.id.length > 255) {
			return refuse("bad_context");
		}
		context = { id: ctx.id, title: isString(ctx.title) ? ctx.title : "" };
	}

	return {
		ok: true,
		launch: {
			platform,
			subject: sub,
			displayName: displayNameOf(claims),
			email: isString(claims.email) && claims.email !== "" ? claims.email : null,
			username: usernameOf(claims),
			role: mapLtiRoles(claims[`${CLAIM}roles`]),
			context,
			targetLinkUri: target,
		},
	};
}
