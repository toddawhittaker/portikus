import { generateKeyPairSync, sign } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { type LtiPlatform, ltiStateCookieName } from "@portikus/auth";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { PUBLIC_URL } from "./test-support.js";

/**
 * A fake LMS for route tests: a local keyset, hand-signed id_tokens, and the
 * whole login-then-launch round trip against the API (ADR 0025).
 */

export const LTI_ISSUER = "https://lms.test.invalid";
export const LTI_CLIENT_ID = "client-1";
export const LTI_CLAIM = "https://purl.imsglobal.org/spec/lti/claim/";
export const LTI_DL_CLAIM = "https://purl.imsglobal.org/spec/lti-dl/claim/";
export const LTI_ROLE = "http://purl.imsglobal.org/vocab/lis/v2/membership#";

export interface FakeLms {
	platform: LtiPlatform;
	/** Sign claims with the platform's key, as the LMS would. */
	mint(claims: Record<string, unknown>): string;
	close(): Promise<void>;
}

export async function startFakeLms(): Promise<FakeLms> {
	const signing = generateKeyPairSync("rsa", { modulusLength: 2048 });
	const server = createServer((_request, response) => {
		const jwk = {
			...signing.publicKey.export({ format: "jwk" }),
			kid: "k1",
			alg: "RS256",
		};
		response.setHeader("content-type", "application/json");
		response.end(JSON.stringify({ keys: [jwk] }));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	const b64 = (value: unknown) =>
		Buffer.from(JSON.stringify(value)).toString("base64url");
	return {
		platform: {
			name: "Test LMS",
			issuer: LTI_ISSUER,
			clientId: LTI_CLIENT_ID,
			authLoginUrl: `${LTI_ISSUER}/authorize`,
			keysetUrl: `http://127.0.0.1:${port}/jwks`,
			deploymentIds: ["dep-1"],
			mock: true,
		},
		mint(claims) {
			const input = `${b64({ alg: "RS256", typ: "JWT", kid: "k1" })}.${b64(claims)}`;
			const signature = sign("sha256", Buffer.from(input), signing.privateKey);
			return `${input}.${signature.toString("base64url")}`;
		},
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
}

export interface LaunchPerson {
	sub: string;
	roles?: string[];
	custom?: Record<string, unknown>;
}

/** A good resource-link launch's claims. */
export function resourceLinkClaims(
	person: LaunchPerson,
	nonce: string,
): Record<string, unknown> {
	const now = Math.floor(Date.now() / 1000);
	return {
		iss: LTI_ISSUER,
		aud: LTI_CLIENT_ID,
		sub: person.sub,
		exp: now + 300,
		iat: now,
		nonce,
		name: "Sam Student",
		email: "sam@example.edu",
		[`${LTI_CLAIM}deployment_id`]: "dep-1",
		[`${LTI_CLAIM}message_type`]: "LtiResourceLinkRequest",
		[`${LTI_CLAIM}version`]: "1.3.0",
		[`${LTI_CLAIM}target_link_uri`]: `${PUBLIC_URL}/`,
		[`${LTI_CLAIM}resource_link`]: { id: "rl-1" },
		[`${LTI_CLAIM}roles`]: person.roles ?? [`${LTI_ROLE}Learner`],
		[`${LTI_CLAIM}context`]: { id: "ctx-1", title: "CS 101" },
		...(person.custom ? { [`${LTI_CLAIM}custom`]: person.custom } : {}),
	};
}

/** A good Deep Linking request's claims, from an instructor by default. */
export function deepLinkingClaims(
	person: LaunchPerson,
	nonce: string,
	returnUrl = `${LTI_ISSUER}/deeplink/return`,
): Record<string, unknown> {
	const claims = resourceLinkClaims(
		{ roles: [`${LTI_ROLE}Instructor`], ...person },
		nonce,
	);
	delete claims[`${LTI_CLAIM}resource_link`];
	claims[`${LTI_CLAIM}message_type`] = "LtiDeepLinkingRequest";
	claims[`${LTI_DL_CLAIM}deep_linking_settings`] = {
		deep_link_return_url: returnUrl,
		accept_types: ["ltiResourceLink"],
		data: "opaque-data",
	};
	return claims;
}

/** Start a login and return its state and nonce. */
async function startLtiLogin(
	app: FastifyInstance,
): Promise<{ state: string; nonce: string }> {
	const query = new URLSearchParams({
		iss: LTI_ISSUER,
		login_hint: "hint",
		target_link_uri: `${PUBLIC_URL}/`,
		client_id: LTI_CLIENT_ID,
	});
	const res = await app.inject({ url: `/lti/login?${query}` });
	if (res.statusCode !== 302) throw new Error(`login answered ${res.statusCode}`);
	const location = new URL(res.headers.location as string);
	return {
		state: location.searchParams.get("state") ?? "",
		nonce: location.searchParams.get("nonce") ?? "",
	};
}

/** A whole login and launch; `claimsFor` builds the token's claims from the nonce. */
export async function ltiLaunch(
	app: FastifyInstance,
	lms: FakeLms,
	claimsFor: (nonce: string) => Record<string, unknown>,
): Promise<LightMyRequestResponse> {
	const { state, nonce } = await startLtiLogin(app);
	return app.inject({
		method: "POST",
		url: "/lti/launch",
		headers: {
			"content-type": "application/x-www-form-urlencoded",
			cookie: `${ltiStateCookieName(state)}=${state}`,
		},
		payload: new URLSearchParams({
			id_token: lms.mint(claimsFor(nonce)),
			state,
		}).toString(),
	});
}

/** The session cookie a response set, if any. */
export function sessionCookieOf(res: LightMyRequestResponse): string | undefined {
	return res.cookies.find((one) => one.name === "portikus_session")?.value;
}
