import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import type { AddressInfo } from "node:net";
import * as net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createKeySetSource } from "./lti/validate.js";
import { createOidcClient } from "./oidc.js";
import { createOutboundFetch } from "./outbound-fetch.js";
import {
	MOCK_CLIENT_ID,
	MOCK_CLIENT_SECRET,
	type MockOidcProvider,
	startMockOidcProvider,
} from "./testing/mock-oidc.js";
import type { AuthOptions } from "./types.js";

// The issuer's host does not resolve, so a request can only succeed through
// the stub proxy, which maps it to the mock (docs/archive/epics/EPIC-14.md ruling 27).
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

describe("HTTPS through the outbound proxy", () => {
	let target: https.Server;
	let tunnelProxy: http.Server;
	let tunnelProxyUrl: string;
	const tunnels: string[] = [];
	let savedRejectUnauthorized: string | undefined;

	beforeAll(async () => {
		// A throwaway self-signed certificate for the local HTTPS server.
		const dir = mkdtempSync(join(tmpdir(), "outbound-fetch-"));
		execFileSync(
			"openssl",
			[
				"req",
				"-x509",
				"-newkey",
				"rsa:2048",
				"-nodes",
				"-days",
				"1",
				"-subj",
				"/CN=localhost",
				"-keyout",
				join(dir, "key.pem"),
				"-out",
				join(dir, "cert.pem"),
			],
			{ stdio: "ignore" },
		);
		const key = readFileSync(join(dir, "key.pem"));
		const cert = readFileSync(join(dir, "cert.pem"));
		rmSync(dir, { recursive: true, force: true });
		target = https.createServer({ key, cert }, (_req, res) => {
			res.writeHead(200, { "content-type": "text/plain" }).end("secure hello");
		});
		await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
		const targetPort = (target.address() as AddressInfo).port;

		// A proxy that only tunnels: it answers CONNECT and pipes raw bytes.
		tunnelProxy = http.createServer((_req, res) => res.writeHead(405).end());
		tunnelProxy.on("connect", (req, socket, head) => {
			tunnels.push(req.url ?? "");
			const upstream = net.connect(targetPort, "127.0.0.1", () => {
				socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
				upstream.write(head);
				upstream.pipe(socket);
				socket.pipe(upstream);
			});
			upstream.on("error", () => socket.destroy());
			socket.on("error", () => upstream.destroy());
		});
		await new Promise<void>((resolve) => tunnelProxy.listen(0, "127.0.0.1", resolve));
		tunnelProxyUrl = `http://127.0.0.1:${(tunnelProxy.address() as AddressInfo).port}`;
		// The module takes no TLS options, so trust the self-signed test
		// certificate the only way it can: for this block's duration.
		savedRejectUnauthorized = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
		process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
	});

	afterAll(async () => {
		if (savedRejectUnauthorized === undefined) {
			delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
		} else {
			process.env.NODE_TLS_REJECT_UNAUTHORIZED = savedRejectUnauthorized;
		}
		tunnelProxy.closeAllConnections();
		target.closeAllConnections();
		await new Promise((resolve) => tunnelProxy.close(resolve));
		await new Promise((resolve) => target.close(resolve));
	});

	test("an https request goes through a CONNECT tunnel and succeeds", async () => {
		const outbound = createOutboundFetch(tunnelProxyUrl);
		// The host does not resolve, so only the tunnel can reach the server.
		const response = await outbound("https://idp.invalid/secure", {});
		expect(response.status).toBe(200);
		expect(await response.text()).toBe("secure hello");
		expect(tunnels).toEqual(["idp.invalid:443"]);
	});
});
