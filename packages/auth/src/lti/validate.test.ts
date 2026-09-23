import { generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { LtiPlatform } from "./platforms.js";
import type { LtiLoginState } from "./state.js";
import {
	createKeySetSource,
	type LtiRefusal,
	validateLaunchToken,
} from "./validate.js";

const PUBLIC_URL = "https://portikus.example.edu";
const CLAIM = "https://purl.imsglobal.org/spec/lti/claim/";
const NOW = new Date("2026-09-23T12:00:00Z");
const NOW_S = Math.floor(NOW.getTime() / 1000);

function keyPair(): { privateKey: KeyObject; publicKey: KeyObject } {
	return generateKeyPairSync("rsa", { modulusLength: 2048 });
}

const good = keyPair();
const other = keyPair();

let server: Server;
let jwksHits = 0;
let jwksStatus = 200;
let platform: LtiPlatform;

function b64(value: unknown): string {
	return Buffer.from(JSON.stringify(value)).toString("base64url");
}

/** Build a JWT by hand, so a test can make it wrong in exactly one way. */
function token(
	claims: Record<string, unknown>,
	options: { alg?: string; kid?: string; key?: KeyObject; tamper?: boolean } = {},
): string {
	const header = {
		alg: options.alg ?? "RS256",
		typ: "JWT",
		kid: options.kid ?? "good",
	};
	const input = `${b64(header)}.${b64(claims)}`;
	if (options.alg === "none") return `${input}.`;
	let signature = sign("sha256", Buffer.from(input), options.key ?? good.privateKey);
	if (options.tamper) signature = Buffer.from(signature.map((b) => b ^ 0xff));
	return `${input}.${signature.toString("base64url")}`;
}

const loginState: LtiLoginState = {
	nonce: "the-nonce",
	platformIssuer: "https://lms.example.edu",
	clientId: "client-1",
};

function claims(): Record<string, unknown> {
	return {
		iss: "https://lms.example.edu",
		aud: "client-1",
		sub: "user-123",
		exp: NOW_S + 300,
		iat: NOW_S,
		nonce: "the-nonce",
		name: "Ivy Instructor",
		email: "ivy@example.edu",
		[`${CLAIM}deployment_id`]: "dep-1",
		[`${CLAIM}message_type`]: "LtiResourceLinkRequest",
		[`${CLAIM}version`]: "1.3.0",
		[`${CLAIM}target_link_uri`]: `${PUBLIC_URL}/`,
		[`${CLAIM}resource_link`]: { id: "rl-1" },
		[`${CLAIM}roles`]: ["http://purl.imsglobal.org/vocab/lis/v2/membership#Instructor"],
		[`${CLAIM}context`]: { id: "ctx-1", title: "CS 101" },
	};
}

beforeAll(async () => {
	const jwk = {
		...good.publicKey.export({ format: "jwk" }),
		kid: "good",
		alg: "RS256",
		use: "sig",
	};
	server = createServer((_req, res) => {
		jwksHits += 1;
		res.statusCode = jwksStatus;
		res.setHeader("content-type", "application/json");
		res.end(JSON.stringify({ keys: [jwk] }));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	platform = {
		name: "Test LMS",
		issuer: "https://lms.example.edu",
		clientId: "client-1",
		authLoginUrl: "https://lms.example.edu/authorize",
		keysetUrl: `http://127.0.0.1:${port}/jwks`,
		deploymentIds: ["dep-1"],
		mock: true,
	};
});

afterAll(async () => {
	await new Promise((resolve) => server.close(resolve));
});

async function validate(idToken: string, state: LtiLoginState = loginState) {
	return validateLaunchToken({
		idToken,
		loginState: state,
		platforms: [platform],
		publicUrl: PUBLIC_URL,
		keySets: createKeySetSource(),
		now: NOW,
	});
}

async function refusal(
	idToken: string,
	state?: LtiLoginState,
): Promise<LtiRefusal | null> {
	const result = await validate(idToken, state);
	return result.ok ? null : result.reason;
}

describe("validateLaunchToken", () => {
	test("accepts a good launch and maps it", async () => {
		const result = await validate(token(claims()));
		expect(result).toEqual({
			ok: true,
			launch: {
				platform,
				subject: "user-123",
				displayName: "Ivy Instructor",
				email: "ivy@example.edu",
				role: "instructor",
				context: { id: "ctx-1", title: "CS 101" },
				targetLinkUri: `${PUBLIC_URL}/`,
			},
		});
	});

	test("a launch with no context signs in with no course", async () => {
		const c = claims();
		delete c[`${CLAIM}context`];
		const result = await validate(token(c));
		expect(result.ok && result.launch.context).toBeNull();
	});

	test("an array audience with azp is accepted", async () => {
		const result = await validate(
			token({ ...claims(), aud: ["client-1", "other"], azp: "client-1" }),
		);
		expect(result.ok).toBe(true);
	});

	test("a one-element array audience needs no azp", async () => {
		expect((await validate(token({ ...claims(), aud: ["client-1"] }))).ok).toBe(true);
	});

	test("the clock skew allows 60 seconds either way", async () => {
		expect(
			(await validate(token({ ...claims(), exp: NOW_S - 30, iat: NOW_S + 30 }))).ok,
		).toBe(true);
	});

	test.each([
		["name", { name: "  Sam Student " }, "Sam Student"],
		[
			"given and family name",
			{ name: undefined, given_name: "Lee", family_name: "Learner" },
			"Lee Learner",
		],
		["nothing", { name: undefined }, "LTI user"],
	])("display name from %s", async (_label, extra, expected) => {
		const result = await validate(token({ ...claims(), ...extra }));
		expect(result.ok && result.launch.displayName).toBe(expected);
	});

	test("an absent email is null and an untitled context has an empty title", async () => {
		const result = await validate(
			token({ ...claims(), email: undefined, [`${CLAIM}context`]: { id: "c" } }),
		);
		expect(result.ok && result.launch.email).toBeNull();
		expect(result.ok && result.launch.context).toEqual({ id: "c", title: "" });
	});

	// Each token below is wrong in exactly one way.
	test.each<[LtiRefusal, () => string]>([
		["alg_not_allowed", () => token(claims(), { alg: "none" })],
		["alg_not_allowed", () => token(claims(), { alg: "HS256" })],
		["bad_signature", () => token(claims(), { tamper: true })],
		["bad_signature", () => token(claims(), { key: other.privateKey })],
		["bad_signature", () => "not-a-jwt"],
		["unknown_issuer", () => token({ ...claims(), iss: "https://evil.example.com" })],
		["wrong_audience", () => token({ ...claims(), aud: "someone-else" })],
		["wrong_audience", () => token({ ...claims(), aud: ["someone-else", "x"] })],
		["wrong_audience", () => token({ ...claims(), aud: ["client-1", "other"] })],
		[
			"wrong_audience",
			() => token({ ...claims(), aud: ["client-1", "other"], azp: "other" }),
		],
		["expired", () => token({ ...claims(), exp: NOW_S - 61 })],
		["expired", () => token({ ...claims(), exp: undefined })],
		["issued_in_future", () => token({ ...claims(), iat: NOW_S + 61 })],
		["issued_in_future", () => token({ ...claims(), iat: undefined })],
		["nonce_mismatch", () => token({ ...claims(), nonce: "replayed" })],
		[
			"unknown_deployment",
			() => token({ ...claims(), [`${CLAIM}deployment_id`]: "dep-9" }),
		],
		[
			"wrong_message_type",
			() => token({ ...claims(), [`${CLAIM}message_type`]: "LtiDeepLinkingRequest" }),
		],
		["wrong_version", () => token({ ...claims(), [`${CLAIM}version`]: "1.1" })],
		[
			"wrong_target",
			() =>
				token({
					...claims(),
					[`${CLAIM}target_link_uri`]: "https://evil.example.com/",
				}),
		],
		[
			"wrong_target",
			() => token({ ...claims(), [`${CLAIM}target_link_uri`]: "not a url" }),
		],
		["missing_subject", () => token({ ...claims(), sub: undefined })],
		["missing_subject", () => token({ ...claims(), sub: "" })],
		["missing_subject", () => token({ ...claims(), sub: "x".repeat(256) })],
		[
			"missing_resource_link",
			() => token({ ...claims(), [`${CLAIM}resource_link`]: {} }),
		],
		[
			"bad_context",
			() => token({ ...claims(), [`${CLAIM}context`]: { id: "x".repeat(256) } }),
		],
		["bad_context", () => token({ ...claims(), [`${CLAIM}context`]: "ctx" })],
	])("refuses %s", async (reason, build) => {
		expect(await refusal(build())).toBe(reason);
	});

	test("refuses a login whose registration is gone as unknown_issuer", async () => {
		const result = await validate(token(claims()), { ...loginState, clientId: "gone" });
		expect(result).toEqual({ ok: false, reason: "unknown_issuer", platform: null });
	});

	test("a refusal names the platform for the audit row", async () => {
		const result = await validate(token({ ...claims(), nonce: "x" }));
		expect(!result.ok && result.platform?.name).toBe("Test LMS");
	});

	test("an unreachable keyset is keyset_unavailable", async () => {
		jwksStatus = 500;
		try {
			expect(await refusal(token(claims()))).toBe("keyset_unavailable");
		} finally {
			jwksStatus = 200;
		}
	});

	test("an unknown kid refetches the keyset at most once per 30 seconds", async () => {
		const keySets = createKeySetSource();
		const run = (idToken: string) =>
			validateLaunchToken({
				idToken,
				loginState,
				platforms: [platform],
				publicUrl: PUBLIC_URL,
				keySets,
				now: NOW,
			});
		const before = jwksHits;
		expect((await run(token(claims()))).ok).toBe(true);
		expect(jwksHits - before).toBe(1);
		// Cached: a second good launch fetches nothing.
		expect((await run(token(claims()))).ok).toBe(true);
		expect(jwksHits - before).toBe(1);
		// Two unknown kids in a row cause at most one refetch.
		const unknown = token(claims(), { kid: "rotated", key: other.privateKey });
		expect(await run(unknown)).toMatchObject({ ok: false, reason: "bad_signature" });
		expect(await run(unknown)).toMatchObject({ ok: false, reason: "bad_signature" });
		expect(jwksHits - before).toBeLessThanOrEqual(2);
	});

	test("the key set source reuses one set per URL", () => {
		const keySets = createKeySetSource();
		expect(keySets(platform.keysetUrl)).toBe(keySets(platform.keysetUrl));
	});
});
