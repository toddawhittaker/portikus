import { createOutboundFetch } from "@portikus/observability";
import {
	compactVerify,
	createRemoteJWKSet,
	customFetch,
	decodeProtectedHeader,
	errors,
	type JWTVerifyGetKey,
} from "jose";
import { isOnOrigin } from "./login.js";
import type { LtiPlatform } from "./platforms.js";
import { type LtiRole, mapLtiRoles } from "./roles.js";
import type { LtiLoginState } from "./state.js";

/**
 * Every reason a launch is refused, one per check (ADR 0025). `state_missing` and `state_mismatch` come from `checkLaunchState`
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
	| "bad_context"
	| "bad_deep_link_settings"
	| "bad_deep_link_return_url"
	| "resource_link_not_accepted"
	| "not_instructor";

/** What a valid launch says about the person and the course. No token or raw claims. */
interface LtiLaunchCommon {
	platform: LtiPlatform;
	/** The deployment the message came through; a Deep Linking response must echo it. */
	deploymentId: string;
	subject: string;
	/** `name`, else given and family name, else "LTI user". */
	displayName: string;
	/** For the profile only; never used to find or link an account. */
	email: string | null;
	/** `preferred_username`, else the custom claim `username`; names the workspace (SPEC.md section 14.3). */
	username: string | null;
	role: LtiRole;
	/** Absent when the launch had no context claim: sign in, record no membership. */
	context: { id: string; title: string } | null;
	targetLinkUri: string;
	/** The NRPS claim's `context_memberships_url`, or null when absent or unusable. */
	membershipsUrl: string | null;
}

/** A resource-link launch: the person opens Portikus from a course link. */
export interface LtiResourceLinkLaunch extends LtiLaunchCommon {
	kind: "resource_link";
}

/** A Deep Linking request: an instructor picks what a new course link opens. */
export interface LtiDeepLinkingLaunch extends LtiLaunchCommon {
	kind: "deep_linking";
	/** Where the signed response is posted; https, or http for a mock platform. */
	deepLinkReturnUrl: string;
	/** The opaque `data` value the response must echo, or null when none was sent. */
	deepLinkData: string | null;
}

export type LtiLaunch = LtiResourceLinkLaunch | LtiDeepLinkingLaunch;

export type LtiLaunchResult =
	| { ok: true; launch: LtiLaunch }
	| { ok: false; reason: LtiRefusal; platform: LtiPlatform | null };

/** Returns the key-lookup function for a keyset URL, cached per URL. */
export type KeySetSource = (keysetUrl: string) => JWTVerifyGetKey;

const CLAIM = "https://purl.imsglobal.org/spec/lti/claim/";
const DEEP_LINKING_SETTINGS =
	"https://purl.imsglobal.org/spec/lti-dl/claim/deep_linking_settings";
const NRPS_CLAIM = "https://purl.imsglobal.org/spec/lti-nrps/claim/namesroleservice";
const MAX_URL_LENGTH = 2048;
// The data value is echoed back verbatim, so an oversized one is refused rather than carried.
const MAX_DEEP_LINK_DATA_LENGTH = 4096;
const CLOCK_SKEW_SECONDS = 60;

/**
 * One remote JWKS per keyset URL, kept for the life of the process: keys
 * cached 10 minutes, an unknown `kid` refetches at most every 30 seconds,
 * each fetch times out after 5 seconds. With a proxy URL the
 * fetches go through the forward proxy (ADR 0027).
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
		// A leading `$` is a substitution variable the LMS did not fill in.
		if (isString(value) && value.trim() !== "" && !value.trim().startsWith("$")) {
			return value.trim();
		}
	}
	return null;
}

type Platform = ValidateLaunchInput["platforms"][number];

/**
 * Check the token's algorithm, its platform, and its signature, in that order,
 * and return its claims. No claim is read before the signature holds.
 */
async function verifySignature(
	input: ValidateLaunchInput,
	platform: Platform | null,
): Promise<{ claims: Record<string, unknown> } | { reason: LtiRefusal }> {
	let alg: unknown;
	try {
		alg = decodeProtectedHeader(input.idToken).alg;
	} catch {
		return { reason: "bad_signature" };
	}
	if (alg !== "RS256") return { reason: "alg_not_allowed" };
	if (!platform) return { reason: "unknown_issuer" };

	try {
		const { payload } = await compactVerify(
			input.idToken,
			input.keySets(platform.keysetUrl),
			{ algorithms: ["RS256"] },
		);
		const parsed = objectClaim(JSON.parse(new TextDecoder().decode(payload)));
		if (!parsed) return { reason: "bad_signature" };
		return { claims: parsed };
	} catch (error) {
		if (
			error instanceof errors.JWSSignatureVerificationFailed ||
			error instanceof errors.JWKSNoMatchingKey ||
			error instanceof errors.JWSInvalid ||
			error instanceof SyntaxError
		) {
			return { reason: "bad_signature" };
		}
		return { reason: "keyset_unavailable" };
	}
}

/** The audience names this client, and with several audiences azp does too. */
function audienceMatches(claims: Record<string, unknown>, clientId: string): boolean {
	const aud = claims.aud;
	if (Array.isArray(aud)) {
		if (!aud.includes(clientId)) return false;
		if (aud.length > 1 && claims.azp !== clientId) return false;
		return true;
	}
	return aud === clientId;
}

/** Refuse a token that has expired or was issued in the future, within the skew. */
function checkTimes(claims: Record<string, unknown>, now: Date): LtiRefusal | null {
	const nowSeconds = Math.floor(now.getTime() / 1000);
	if (typeof claims.exp !== "number" || claims.exp + CLOCK_SKEW_SECONDS <= nowSeconds) {
		return "expired";
	}
	if (typeof claims.iat !== "number" || claims.iat - CLOCK_SKEW_SECONDS > nowSeconds) {
		return "issued_in_future";
	}
	return null;
}

/** The optional context claim, or "bad" when it is present but malformed. */
function contextOf(claims: Record<string, unknown>): LtiLaunch["context"] | "bad" {
	const rawContext = claims[`${CLAIM}context`];
	if (rawContext === undefined) return null;
	const ctx = objectClaim(rawContext);
	if (!ctx || !isString(ctx.id) || ctx.id.length < 1 || ctx.id.length > 255) {
		return "bad";
	}
	return { id: ctx.id, title: isString(ctx.title) ? ctx.title : "" };
}

/** An absolute URL of bounded length, https or (for a mock platform) http. */
function platformUrl(value: unknown, platform: LtiPlatform): string | null {
	if (!isString(value) || value.length > MAX_URL_LENGTH) return null;
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return null;
	}
	const allowed = platform.mock ? ["https:", "http:"] : ["https:"];
	return allowed.includes(url.protocol) ? value : null;
}

/** The roster URL from the NRPS claim; an unusable one means no roster, not a refused launch. */
function membershipsUrlOf(
	claims: Record<string, unknown>,
	platform: LtiPlatform,
): string | null {
	const nrps = objectClaim(claims[NRPS_CLAIM]);
	return nrps ? platformUrl(nrps.context_memberships_url, platform) : null;
}

type DeepLinkSettings = { returnUrl: string; data: string | null };

/** The deep-linking settings claim, or the refusal that says what is wrong with it. */
function deepLinkSettingsOf(
	claims: Record<string, unknown>,
	platform: LtiPlatform,
): DeepLinkSettings | LtiRefusal {
	const settings = objectClaim(claims[DEEP_LINKING_SETTINGS]);
	if (!settings) return "bad_deep_link_settings";
	const data = settings.data;
	if (
		data !== undefined &&
		(!isString(data) || data.length > MAX_DEEP_LINK_DATA_LENGTH)
	) {
		return "bad_deep_link_settings";
	}
	const returnUrl = platformUrl(settings.deep_link_return_url, platform);
	if (!returnUrl) return "bad_deep_link_return_url";
	const acceptTypes = settings.accept_types;
	if (!Array.isArray(acceptTypes) || !acceptTypes.includes("ltiResourceLink")) {
		return "resource_link_not_accepted";
	}
	return { returnUrl, data: isString(data) ? data : null };
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

	const verified = await verifySignature(input, platform);
	if ("reason" in verified) return refuse(verified.reason);
	const { claims } = verified;
	// verifySignature refuses before this point when there is no platform.
	if (!platform) return refuse("unknown_issuer");

	// The login started with this platform, so the token must come from it.
	if (claims.iss !== platform.issuer) return refuse("unknown_issuer");

	if (!audienceMatches(claims, platform.clientId)) return refuse("wrong_audience");

	const timeRefusal = checkTimes(claims, input.now ?? new Date());
	if (timeRefusal) return refuse(timeRefusal);

	if (claims.nonce !== loginState.nonce) return refuse("nonce_mismatch");

	const deploymentId = claims[`${CLAIM}deployment_id`];
	if (!isString(deploymentId) || !platform.deploymentIds.includes(deploymentId)) {
		return refuse("unknown_deployment");
	}
	const messageType = claims[`${CLAIM}message_type`];
	if (
		messageType !== "LtiResourceLinkRequest" &&
		messageType !== "LtiDeepLinkingRequest"
	) {
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

	// A Deep Linking request has no resource link: it is how one gets made.
	if (messageType === "LtiResourceLinkRequest") {
		const resourceLink = objectClaim(claims[`${CLAIM}resource_link`]);
		if (!resourceLink || !isString(resourceLink.id) || resourceLink.id === "") {
			return refuse("missing_resource_link");
		}
	}

	const context = contextOf(claims);
	if (context === "bad") return refuse("bad_context");

	const role = mapLtiRoles(claims[`${CLAIM}roles`]);
	const common: LtiLaunchCommon = {
		platform,
		deploymentId,
		subject: sub,
		displayName: displayNameOf(claims),
		email: isString(claims.email) && claims.email !== "" ? claims.email : null,
		username: usernameOf(claims),
		role,
		context,
		targetLinkUri: target,
		membershipsUrl: membershipsUrlOf(claims, platform),
	};
	if (messageType === "LtiResourceLinkRequest") {
		return { ok: true, launch: { ...common, kind: "resource_link" } };
	}

	const settings = deepLinkSettingsOf(claims, platform);
	if (isString(settings)) return refuse(settings);
	// Only teaching staff choose what a course link opens.
	if (role !== "instructor") return refuse("not_instructor");
	return {
		ok: true,
		launch: {
			...common,
			kind: "deep_linking",
			deepLinkReturnUrl: settings.returnUrl,
			deepLinkData: settings.data,
		},
	};
}
