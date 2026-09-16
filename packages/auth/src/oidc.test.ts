import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createOidcClient, OidcError } from "./oidc.js";
import {
	MOCK_CLIENT_ID,
	MOCK_CLIENT_SECRET,
	type MockOidcProvider,
	startMockOidcProvider,
} from "./testing/mock-oidc.js";
import type { AuthOptions } from "./types.js";

const PUBLIC_URL = "http://127.0.0.1:5173";

function authOptions(issuerUrl: string): AuthOptions {
	return {
		publicUrl: PUBLIC_URL,
		issuerUrl,
		clientId: MOCK_CLIENT_ID,
		clientSecret: MOCK_CLIENT_SECRET,
		scopes: "openid profile email groups",
		groupsClaim: "groups",
		studentGroup: "portikus-students",
		adminGroup: "portikus-administrators",
		cookieSecret: "cookie-secret",
		sessionTtlSeconds: 43200,
	};
}

/** Follow the mock's consent redirect for one user and return the callback URL. */
async function pickUser(authorizeUrl: string, user: string): Promise<URL> {
	const url = new URL(authorizeUrl);
	url.searchParams.set("user", user);
	const response = await fetch(url, { redirect: "manual" });
	const location = response.headers.get("location");
	expect(location, `mock did not redirect (status ${response.status})`).toBeTruthy();
	return new URL(location as string);
}

describe("createOidcClient against the mock provider", () => {
	let mock: MockOidcProvider;

	beforeAll(async () => {
		mock = await startMockOidcProvider({
			redirectUris: [`${PUBLIC_URL}/auth/callback`],
		});
	});

	afterAll(async () => {
		await mock.close();
	});

	test("discovery advertises endpoints under the issuer", async () => {
		const response = await fetch(`${mock.issuer}/.well-known/openid-configuration`);
		const doc = (await response.json()) as Record<string, string>;
		expect(doc.issuer).toBe(mock.issuer);
		expect(doc.authorization_endpoint).toBe(`${mock.issuer}/authorize`);
		expect(doc.token_endpoint).toBe(`${mock.issuer}/token`);
		expect(doc.jwks_uri).toBe(`${mock.issuer}/jwks`);
		expect(doc.userinfo_endpoint).toBe(`${mock.issuer}/userinfo`);
	});

	test("the consent page lists the mock users", async () => {
		const oidc = createOidcClient(authOptions(mock.issuer));
		const { url } = await oidc.buildLoginRedirect();
		const html = await (await fetch(url)).text();
		expect(html).toContain('data-testid="mock-user-alice"');
		expect(html).toContain("Carol Admin");
	});

	test("a full login round trip yields identity and claims", async () => {
		const oidc = createOidcClient(authOptions(mock.issuer));
		const { url, state } = await oidc.buildLoginRedirect();
		expect(url).toContain("code_challenge_method=S256");

		const callbackUrl = await pickUser(url, "alice");
		expect(callbackUrl.pathname).toBe("/auth/callback");

		const { identity, claims } = await oidc.completeLogin(callbackUrl, state);
		expect(identity.issuer).toBe(mock.issuer);
		expect(identity.subject).toBe("alice");
		expect(identity.email).toBe("alice@example.edu");
		expect(identity.displayName).toBe("Alice Student");
		expect(claims.groups).toEqual(["portikus-students"]);
	});

	test("an authorization code can only be used once", async () => {
		const oidc = createOidcClient(authOptions(mock.issuer));
		const { url, state } = await oidc.buildLoginRedirect();
		const callbackUrl = await pickUser(url, "bob");

		await oidc.completeLogin(callbackUrl, state);
		await expect(oidc.completeLogin(callbackUrl, state)).rejects.toBeInstanceOf(
			OidcError,
		);
	});

	test("a mismatched state is rejected", async () => {
		const oidc = createOidcClient(authOptions(mock.issuer));
		const { url, state } = await oidc.buildLoginRedirect();
		const callbackUrl = await pickUser(url, "alice");

		await expect(
			oidc.completeLogin(callbackUrl, { ...state, state: "not-the-state" }),
		).rejects.toBeInstanceOf(OidcError);
	});

	test("a mismatched nonce is rejected", async () => {
		const oidc = createOidcClient(authOptions(mock.issuer));
		const { url, state } = await oidc.buildLoginRedirect();
		const callbackUrl = await pickUser(url, "alice");

		await expect(
			oidc.completeLogin(callbackUrl, { ...state, nonce: "not-the-nonce" }),
		).rejects.toBeInstanceOf(OidcError);
	});

	test("a mismatched PKCE verifier is rejected", async () => {
		const oidc = createOidcClient(authOptions(mock.issuer));
		const { url, state } = await oidc.buildLoginRedirect();
		const callbackUrl = await pickUser(url, "alice");

		await expect(
			oidc.completeLogin(callbackUrl, { ...state, verifier: "a".repeat(43) }),
		).rejects.toBeInstanceOf(OidcError);
	});

	test("errors never leak the client secret", async () => {
		const oidc = createOidcClient(authOptions(mock.issuer));
		const { url, state } = await oidc.buildLoginRedirect();
		const callbackUrl = await pickUser(url, "alice");
		callbackUrl.searchParams.set("code", "forged");

		const error = await oidc.completeLogin(callbackUrl, state).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(OidcError);
		expect((error as Error).message).not.toContain(MOCK_CLIENT_SECRET);
		expect((error as Error).message).not.toContain("forged");
	});

	test("discovery failure is reported and retried later", async () => {
		const oidc = createOidcClient(authOptions("http://127.0.0.1:1/dead-idp"));
		await expect(oidc.buildLoginRedirect()).rejects.toBeInstanceOf(OidcError);
		await expect(oidc.buildLoginRedirect()).rejects.toBeInstanceOf(OidcError);
	});
});

describe("an issuer with a path prefix", () => {
	let mock: MockOidcProvider;

	beforeAll(async () => {
		// The pilot VM serves the mock behind Caddy at /mock-idp.
		const probe = await startMockOidcProvider({
			issuer: "http://127.0.0.1:0/mock-idp",
		});
		await probe.close();
		mock = await startMockOidcProvider({
			port: probe.port,
			issuer: `http://127.0.0.1:${probe.port}/mock-idp`,
			redirectUris: [`${PUBLIC_URL}/auth/callback`],
		});
	});

	afterAll(async () => {
		await mock.close();
	});

	test("the whole flow works under the prefix", async () => {
		expect(mock.issuer).toContain("/mock-idp");
		const oidc = createOidcClient(authOptions(mock.issuer));
		const { url, state } = await oidc.buildLoginRedirect();
		expect(url).toContain("/mock-idp/authorize");

		const callbackUrl = await pickUser(url, "carol");
		const { identity, claims } = await oidc.completeLogin(callbackUrl, state);
		expect(identity.subject).toBe("carol");
		expect(identity.issuer).toBe(mock.issuer);
		expect(claims.groups).toEqual(["portikus-administrators"]);
	});
});

describe("the mock provider's redirect_uri allow list", () => {
	let mock: MockOidcProvider;

	beforeAll(async () => {
		mock = await startMockOidcProvider({
			redirectUris: [`${PUBLIC_URL}/auth/callback`],
		});
	});

	afterAll(async () => {
		await mock.close();
	});

	test("an unlisted redirect_uri is refused", async () => {
		const url = new URL(`${mock.issuer}/authorize`);
		url.searchParams.set("client_id", MOCK_CLIENT_ID);
		url.searchParams.set("redirect_uri", "https://evil.example.com/steal");
		url.searchParams.set("code_challenge", "x".repeat(43));
		url.searchParams.set("code_challenge_method", "S256");
		url.searchParams.set("user", "alice");

		const response = await fetch(url, { redirect: "manual" });
		expect(response.status).toBe(400);
	});

	test("credentials come from the options", async () => {
		const custom = await startMockOidcProvider({
			clientId: "other-client",
			clientSecret: "other-secret",
			redirectUris: [`${PUBLIC_URL}/auth/callback`],
		});
		try {
			const url = new URL(`${custom.issuer}/authorize`);
			url.searchParams.set("client_id", MOCK_CLIENT_ID);
			url.searchParams.set("redirect_uri", `${PUBLIC_URL}/auth/callback`);
			url.searchParams.set("code_challenge", "x".repeat(43));
			url.searchParams.set("code_challenge_method", "S256");
			const response = await fetch(url, { redirect: "manual" });
			expect(response.status).toBe(400);
		} finally {
			await custom.close();
		}
	});
});
