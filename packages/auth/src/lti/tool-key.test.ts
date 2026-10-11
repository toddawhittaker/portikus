import { createHash, generateKeyPairSync } from "node:crypto";
import { describe, expect, test } from "vitest";
import { signDeepLinkingResponse } from "./deep-linking.js";
import { requestNrpsToken } from "./nrps.js";
import { toolJwks, toolKeyId } from "./tool-key.js";

const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const rsaPem = rsa.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
const ec = generateKeyPairSync("ec", { namedCurve: "P-256" });
const ecPem = ec.privateKey.export({ format: "pem", type: "pkcs8" }).toString();

describe("toolJwks", () => {
	test("publishes only the public half, with the RFC 7638 thumbprint as kid", () => {
		const { keys } = toolJwks(rsaPem);
		expect(keys).toHaveLength(1);
		const key = keys[0] ?? {};
		expect(key).toMatchObject({ kty: "RSA", alg: "RS256", use: "sig" });
		expect(key.d).toBeUndefined();
		const thumbprint = createHash("sha256")
			.update(JSON.stringify({ e: key.e, kty: "RSA", n: key.n }))
			.digest("base64url");
		expect(key.kid).toBe(thumbprint);
	});

	test("is empty with no key, or with a key that cannot sign RS256", () => {
		expect(toolJwks(null)).toEqual({ keys: [] });
		expect(toolJwks(ecPem)).toEqual({ keys: [] });
	});
});

describe("toolKeyId", () => {
	test("is the kid the keyset publishes for the same key", () => {
		expect(toolKeyId(rsaPem)).toBe(toolJwks(rsaPem).keys[0]?.kid);
	});

	test("throws rather than return an empty kid", () => {
		expect(() => toolKeyId(ecPem)).toThrow(/no RSA key id/);
	});
});

describe("signing with a key that has no kid", () => {
	test("a Deep Linking response is refused", async () => {
		await expect(
			signDeepLinkingResponse({
				toolKeyPem: ecPem,
				clientId: "c",
				platformIssuer: "https://lms.example.edu",
				deploymentId: "d",
				data: null,
				contentItems: [],
			}),
		).rejects.toThrow(/no RSA key id/);
	});

	test("a roster token request is refused before anything is sent", async () => {
		await expect(
			requestNrpsToken({
				tokenUrl: "http://127.0.0.1:9/token",
				clientId: "c",
				toolKeyPem: ecPem,
			}),
		).rejects.toThrow(/no RSA key id/);
	});
});
