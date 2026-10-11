import { generateKeyPairSync } from "node:crypto";
import { decodeProtectedHeader, errors, jwtVerify } from "jose";
import { describe, expect, test } from "vitest";
import {
	type DeepLinkingResponseInput,
	signDeepLinkingResponse,
} from "./deep-linking.js";
import { toolKeyId } from "./tool-key.js";

const CLAIM = "https://purl.imsglobal.org/spec/lti/claim/";
const DL_CLAIM = "https://purl.imsglobal.org/spec/lti-dl/claim/";
const NOW = new Date("2026-10-10T12:00:00Z");
const NOW_S = Math.floor(NOW.getTime() / 1000);

const tool = generateKeyPairSync("rsa", { modulusLength: 2048 });
const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
const toolKeyPem = tool.privateKey.export({ format: "pem", type: "pkcs8" }).toString();

function input(
	extra: Partial<DeepLinkingResponseInput> = {},
): DeepLinkingResponseInput {
	return {
		toolKeyPem,
		clientId: "client-1",
		platformIssuer: "https://lms.example.edu",
		deploymentId: "dep-1",
		data: "opaque-123",
		contentItems: [
			{
				title: "Lab 1",
				url: "https://portikus.example.edu/",
				custom: { portikus_project: "Lab 1", portikus_template: "python" },
			},
		],
		now: NOW,
		...extra,
	};
}

async function verify(jwt: string, key = tool.publicKey) {
	return jwtVerify(jwt, key, {
		algorithms: ["RS256"],
		issuer: "client-1",
		audience: "https://lms.example.edu",
		currentDate: NOW,
	});
}

describe("signDeepLinkingResponse", () => {
	test("the tool's public key verifies it, with the tool as issuer and the platform as audience", async () => {
		const jwt = await signDeepLinkingResponse(input());
		const { payload, protectedHeader } = await verify(jwt);
		expect(protectedHeader).toEqual({
			alg: "RS256",
			typ: "JWT",
			kid: toolKeyId(toolKeyPem),
		});
		expect(payload.iss).toBe("client-1");
		expect(payload.aud).toBe("https://lms.example.edu");
		expect(payload.iat).toBe(NOW_S);
		expect(payload.exp).toBe(NOW_S + 300);
		expect(payload[`${CLAIM}message_type`]).toBe("LtiDeepLinkingResponse");
		expect(payload[`${CLAIM}version`]).toBe("1.3.0");
		expect(payload[`${CLAIM}deployment_id`]).toBe("dep-1");
		expect(payload[`${DL_CLAIM}data`]).toBe("opaque-123");
		expect(payload[`${DL_CLAIM}content_items`]).toEqual([
			{
				type: "ltiResourceLink",
				title: "Lab 1",
				url: "https://portikus.example.edu/",
				custom: { portikus_project: "Lab 1", portikus_template: "python" },
			},
		]);
	});

	test("another key does not verify it", async () => {
		const jwt = await signDeepLinkingResponse(input());
		await expect(verify(jwt, other.publicKey)).rejects.toBeInstanceOf(
			errors.JWSSignatureVerificationFailed,
		);
	});

	test("a verifier expecting another audience refuses it", async () => {
		const jwt = await signDeepLinkingResponse(input());
		await expect(
			jwtVerify(jwt, tool.publicKey, {
				audience: "https://other.example.edu",
				currentDate: NOW,
			}),
		).rejects.toBeInstanceOf(errors.JWTClaimValidationFailed);
	});

	test("with no data the data claim is absent", async () => {
		const { payload } = await verify(
			await signDeepLinkingResponse(input({ data: null })),
		);
		expect(`${DL_CLAIM}data` in payload).toBe(false);
	});

	test("each response has its own nonce", async () => {
		const a = await verify(await signDeepLinkingResponse(input()));
		const b = await verify(await signDeepLinkingResponse(input()));
		expect(typeof a.payload.nonce).toBe("string");
		expect(a.payload.nonce).not.toBe(b.payload.nonce);
	});

	test("a PKCS#1 key works too", async () => {
		const pkcs1 = tool.privateKey.export({ format: "pem", type: "pkcs1" }).toString();
		const jwt = await signDeepLinkingResponse(input({ toolKeyPem: pkcs1 }));
		expect(decodeProtectedHeader(jwt).alg).toBe("RS256");
		await expect(verify(jwt)).resolves.toBeTruthy();
	});
});
