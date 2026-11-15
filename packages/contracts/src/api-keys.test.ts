import { describe, expect, test } from "vitest";
import { AuditEvent } from "./admin.js";
import {
	API_KEY_PERIOD_DEFAULT,
	ApiKey,
	CreateApiKeyRequest,
	RotateApiKeyRequest,
} from "./api-keys.js";

describe("CreateApiKeyRequest", () => {
	test("a name alone makes a read-only 30-day key", () => {
		expect(CreateApiKeyRequest.parse({ name: "  laptop " })).toEqual({
			name: "laptop",
			scope: "read",
			periodDays: API_KEY_PERIOD_DEFAULT,
		});
	});

	test.each([7, 30, 90, null])("period %s is accepted", (periodDays) => {
		expect(CreateApiKeyRequest.parse({ name: "k", periodDays }).periodDays).toBe(
			periodDays,
		);
	});

	test.each([
		["a blank name", { name: "   " }],
		["a name over 100 characters", { name: "x".repeat(101) }],
		["an unknown scope", { name: "k", scope: "root" }],
		["a period that is not offered", { name: "k", periodDays: 365 }],
		["an unknown field", { name: "k", admin: true }],
		[
			"a code and a passkey together",
			{ name: "k", code: "123456", credential: { id: "x" } },
		],
	])("%s is refused", (_label, body) => {
		expect(CreateApiKeyRequest.safeParse(body).success).toBe(false);
	});

	test("a code alone is accepted", () => {
		expect(CreateApiKeyRequest.parse({ name: "k", code: "123456" }).code).toBe(
			"123456",
		);
	});
});

describe("RotateApiKeyRequest", () => {
	test("takes a code or a passkey answer, never both, and nothing else", () => {
		expect(RotateApiKeyRequest.parse({})).toEqual({});
		expect(RotateApiKeyRequest.parse({ code: " 123456 " })).toEqual({ code: "123456" });
		expect(
			RotateApiKeyRequest.safeParse({ code: "1", credential: { id: "x" } }).success,
		).toBe(false);
		expect(RotateApiKeyRequest.safeParse({ name: "k" }).success).toBe(false);
	});
});

describe("ApiKey", () => {
	test("has no field that could carry a secret", () => {
		const parsed = ApiKey.parse({
			id: "00000000-0000-4000-8000-000000000001",
			name: "k",
			prefix: "portikus_abcd",
			scope: "read",
			periodDays: null,
			state: "active",
			createdAt: new Date().toISOString(),
			expiresAt: null,
			lastUsedAt: null,
			revokedAt: null,
			secret: "portikus_leak",
		});
		expect(Object.keys(parsed)).not.toContain("secret");
	});
});

describe("AuditEvent arrival", () => {
	const base = {
		id: 1,
		at: new Date().toISOString(),
		actor: "user:1",
		actorName: null,
		action: "a",
		target: "t",
		result: "ok",
		metadata: null,
	};

	test("carries how a request arrived, always present and null when it was neither", () => {
		const key = "00000000-0000-4000-8000-000000000001";
		expect(AuditEvent.parse({ ...base, via: "api_key", apiKeyId: key })).toMatchObject({
			via: "api_key",
			apiKeyId: key,
		});
		expect(AuditEvent.parse({ ...base, via: null, apiKeyId: null }).via).toBeNull();
		// The audit route always sends both, so a row without them is malformed.
		expect(AuditEvent.safeParse(base).success).toBe(false);
		expect(AuditEvent.safeParse({ ...base, via: "cli" }).success).toBe(false);
	});
});
