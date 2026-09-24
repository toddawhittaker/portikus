import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createKeySetSource } from "./lti/validate.js";
import { createOidcClient } from "./oidc.js";
import {
	MOCK_CLIENT_ID,
	MOCK_CLIENT_SECRET,
	type MockOidcProvider,
	startMockOidcProvider,
} from "./testing/mock-oidc.js";
import type { AuthOptions } from "./types.js";

// The issuer's host does not resolve, so a request can only succeed through
// the stub proxy, which maps it to the mock (docs/EPIC-14.md ruling 27).
const ISSUER = "http://idp.invalid/idp";
const PUBLIC_URL = "http://127.0.0.1:5173";

let mock: MockOidcProvider;
let proxy: http.Server;
let proxyUrl: string;
const proxied: string[] = [];

beforeAll(async () => {
	mock = await startMockOidcProvider({
		issuer: ISSUER,
		redirectUris: [`${PUBLIC_URL}/auth/callback`],
	});
	// A forward proxy that records each destination. undici sends an http
	// target in absolute form (https would be a CONNECT tunnel).
	proxy = http.createServer((req, res) => {
		const target = new URL(req.url ?? "");
		proxied.push(`${target.hostname}:${target.port || "80"}`);
		if (target.hostname !== "idp.invalid") {
			res.writeHead(403).end();
			return;
		}
		const upstream = http.request(
			{
				host: "127.0.0.1",
				port: mock.port,
				method: req.method,
				path: `${target.pathname}${target.search}`,
				headers: req.headers,
			},
			(answer) => {
				res.writeHead(answer.statusCode ?? 502, answer.headers);
				answer.pipe(res);
			},
		);
		upstream.on("error", () => res.destroy());
		req.pipe(upstream);
	});
	await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
	proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
});

afterAll(async () => {
	proxy.closeAllConnections();
	await new Promise((resolve) => proxy.close(resolve));
	await mock.close();
});

beforeEach(() => {
	proxied.length = 0;
});

function authOptions(outboundProxyUrl: string | null): AuthOptions {
	return {
		publicUrl: PUBLIC_URL,
		issuerUrl: ISSUER,
		clientId: MOCK_CLIENT_ID,
		clientSecret: MOCK_CLIENT_SECRET,
		scopes: "openid profile email",
		groupsClaim: "groups",
		studentGroup: "portikus-students",
		adminGroup: "portikus-administrators",
		instructorGroup: "portikus-instructors",
		cookieSecret: "cookie-secret",
		sessionTtlSeconds: 43200,
		outboundProxyUrl,
	};
}

/** Play the browser: pick alice at the mock, which the test reaches directly. */
async function callbackFor(authorizeUrl: string): Promise<URL> {
	const url = new URL(authorizeUrl);
	const direct = new URL(
		`${url.pathname}${url.search}`,
		`http://127.0.0.1:${mock.port}`,
	);
	direct.searchParams.set("user", "alice");
	const response = await fetch(direct, { redirect: "manual" });
	return new URL(response.headers.get("location") as string);
}

describe("OIDC through the outbound proxy", () => {
	test("discovery, token and userinfo requests all go through the proxy", async () => {
		const oidc = createOidcClient(authOptions(proxyUrl));
		const { url, state } = await oidc.buildLoginRedirect();
		const proxiedBeforeCallback = proxied.length;
		expect(proxiedBeforeCallback).toBeGreaterThan(0);

		const { identity } = await oidc.completeLogin(await callbackFor(url), state);
		expect(identity.subject).toBe("alice");
		expect(identity.issuer).toBe(ISSUER);
		// The callback made more requests, and every one used the proxy.
		expect(proxied.length).toBeGreaterThan(proxiedBeforeCallback);
		expect(new Set(proxied)).toEqual(new Set(["idp.invalid:80"]));
	});

	test("without a proxy URL the requests go direct, so the unresolvable issuer fails", async () => {
		const oidc = createOidcClient(authOptions(null));
		await expect(oidc.buildLoginRedirect()).rejects.toThrow(/discovery failed/);
		expect(proxied).toEqual([]);
	});
});

describe("LTI keysets through the outbound proxy", () => {
	const header = { alg: "RS256", kid: "mock-key-1" };
	const token = { payload: "", signature: "" } as never;

	test("a keyset fetch goes through the proxy", async () => {
		const getKey = createKeySetSource(proxyUrl)(`${ISSUER}/jwks`);
		await expect(getKey(header, token)).resolves.toBeTruthy();
		expect(proxied).toEqual(["idp.invalid:80"]);
	});

	test("without a proxy URL the keyset fetch goes direct and fails", async () => {
		const getKey = createKeySetSource(null)(`${ISSUER}/jwks`);
		await expect(getKey(header, token)).rejects.toThrow();
		expect(proxied).toEqual([]);
	});
});
