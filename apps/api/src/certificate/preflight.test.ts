/**
 * Pre-flight (SPEC.md 20.1): failures block HTTP-01 and only warn for
 * DNS-01; a name passes only when the nonce comes back from every address.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { ApiConfig } from "@portikus/config";
import { afterEach, describe, expect, test } from "vitest";
import {
	NonceStore,
	type PreflightNet,
	runAddressPreflight,
	runPreflight,
	systemNet,
} from "./preflight.js";

const config = {
	PUBLIC_URL: "https://portikus.example.edu:8443",
	PREVIEW_SUFFIX: "preview.example.edu",
} as ApiConfig;

/** A network where the named hosts resolve and answer with whatever `answer` gives. */
function fakeNet(
	resolves: (name: string) => string[],
	answer: (url: string, address: string, nonces: NonceStore) => string | null,
	nonces: NonceStore,
): PreflightNet & { urls: string[] } {
	const urls: string[] = [];
	return {
		urls,
		resolve: async (name) => resolves(name),
		probe: async (url, address) => {
			urls.push(url);
			return answer(url, address, nonces);
		},
	};
}

/** Answer the nonce in the path when it is live, as the edge route does. */
function honest(url: string, _address: string, nonces: NonceStore): string | null {
	const nonce = new URL(url).pathname.split("/").pop() ?? "";
	return nonces.has(nonce) ? nonce : null;
}

describe("runPreflight", () => {
	test("passes every check when DNS and the nonce both work", async () => {
		const nonces = new NonceStore();
		const net = fakeNet(() => ["192.0.2.10"], honest, nonces);
		const result = await runPreflight({ config, net, nonces, mode: "http01" });
		expect(result.ok).toBe(true);
		expect(result.checks.map((c) => [c.name, c.result])).toEqual([
			["dns-site", "passed"],
			["dns-preview", "passed"],
			["reach-site", "passed"],
			["reach-preview", "passed"],
			["http-port-80", "passed"],
		]);
		expect(net.urls).toContain(
			`http://portikus.example.edu${"/.well-known/portikus-preflight/"}${net.urls[0]?.split("/").pop()}`,
		);
		expect(
			net.urls.some((u) => u.startsWith("https://portikus.example.edu:8443/")),
		).toBe(true);
	});

	test("a preview name that does not resolve fails HTTP-01", async () => {
		const nonces = new NonceStore();
		const net = fakeNet(
			(name) => (name.endsWith(".preview.example.edu") ? [] : ["192.0.2.10"]),
			honest,
			nonces,
		);
		const result = await runPreflight({ config, net, nonces, mode: "http01" });
		expect(result.ok).toBe(false);
		const failed = result.checks
			.filter((c) => c.result === "failed")
			.map((c) => c.name);
		expect(failed).toEqual(["dns-preview", "reach-preview"]);
		expect(result.checks.find((c) => c.name === "dns-preview")?.message).toContain(
			"*.preview.example.edu",
		);
	});

	test("the same failure only warns for DNS-01, which has no port-80 check", async () => {
		const nonces = new NonceStore();
		const net = fakeNet(
			(name) => (name.endsWith(".preview.example.edu") ? [] : ["192.0.2.10"]),
			honest,
			nonces,
		);
		const result = await runPreflight({ config, net, nonces, mode: "dns01" });
		expect(result.ok).toBe(true);
		expect(result.checks.map((c) => c.result)).toEqual([
			"passed",
			"warning",
			"passed",
			"warning",
		]);
	});

	test("HTTP-01 probes the preview check name over plain http on port 80", async () => {
		// On-demand TLS refuses portikus-check-* names, so https could never pass.
		const nonces = new NonceStore();
		const net = fakeNet(() => ["192.0.2.10"], honest, nonces);
		await runPreflight({ config, net, nonces, mode: "http01" });
		const preview = net.urls.filter((u) => u.includes("portikus-check-"));
		expect(preview).toHaveLength(1);
		expect(preview[0]).toMatch(
			/^http:\/\/portikus-check-[0-9a-f]{8}\.preview\.example\.edu\//,
		);
	});

	test("DNS-01 probes the preview check name over https", async () => {
		const nonces = new NonceStore();
		const net = fakeNet(() => ["192.0.2.10"], honest, nonces);
		await runPreflight({ config, net, nonces, mode: "dns01" });
		const preview = net.urls.filter((u) => u.includes("portikus-check-"));
		expect(preview[0]).toMatch(
			/^https:\/\/portikus-check-[0-9a-f]{8}\.preview\.example\.edu:8443\//,
		);
	});

	test("a name pointing elsewhere at one address fails reach", async () => {
		const nonces = new NonceStore();
		const net = fakeNet(
			() => ["192.0.2.10", "198.51.100.7"],
			(url, address, store) =>
				address === "192.0.2.10" ? honest(url, address, store) : "other",
			nonces,
		);
		const result = await runPreflight({ config, net, nonces, mode: "http01" });
		expect(result.checks.find((c) => c.name === "reach-site")?.result).toBe("failed");
	});
});

describe("NonceStore", () => {
	test("a nonce lives one minute", () => {
		const store = new NonceStore();
		const nonce = store.issue(1_000);
		expect(store.has(nonce, 60_000)).toBe(true);
		expect(store.has(nonce, 62_000)).toBe(false);
		expect(store.has("unknown", 1_000)).toBe(false);
	});
});

describe("systemNet.probe", () => {
	let server: Server | undefined;
	afterEach(
		() =>
			new Promise<void>((done) => {
				server?.closeAllConnections();
				return server ? server.close(() => done()) : done();
			}),
	);

	test("connects to the given address and sends the URL's host name", async () => {
		const seen: string[] = [];
		server = createServer((request, response) => {
			seen.push(request.headers.host ?? "");
			response.end("abc\n");
		});
		await new Promise<void>((done) => server?.listen(0, "127.0.0.1", done));
		const { port } = server.address() as AddressInfo;
		const body = await systemNet.probe(`http://site.invalid:${port}/x`, "127.0.0.1");
		expect(body).toBe("abc");
		expect(seen).toEqual([`site.invalid:${port}`]);
	});

	test("an oversized body that never ends answers null promptly", async () => {
		server = createServer((_request, response) => {
			response.writeHead(200);
			response.write("x".repeat(1024));
		});
		await new Promise<void>((done) => server?.listen(0, "127.0.0.1", done));
		const { port } = server.address() as AddressInfo;
		const started = Date.now();
		expect(
			await systemNet.probe(`http://site.invalid:${port}/x`, "127.0.0.1"),
		).toBeNull();
		expect(Date.now() - started).toBeLessThan(2_000);
	});

	test("answers null when nothing listens", async () => {
		expect(await systemNet.probe("http://site.invalid:1/x", "127.0.0.1")).toBeNull();
	});
});

describe("runAddressPreflight", () => {
	const THIS_SERVER = "192.0.2.10";
	const ELSEWHERE = "198.51.100.7";

	/** Only this server answers the nonce; another machine answers nothing. */
	function onlyHere(url: string, address: string, nonces: NonceStore): string | null {
		return address === THIS_SERVER ? honest(url, address, nonces) : null;
	}

	async function run(resolves: (name: string) => string[]) {
		const nonces = new NonceStore();
		const net = fakeNet(resolves, onlyHere, nonces);
		const result = await runAddressPreflight({
			config,
			net,
			nonces,
			host: "code.example.edu",
			previewSuffix: "preview.code.example.edu",
		});
		return { result, net };
	}

	test("passes when the new names point here, probing through the current site", async () => {
		const { result, net } = await run(() => [THIS_SERVER]);
		expect(result.ok).toBe(true);
		expect(result.checks.map((c) => [c.name, c.result])).toEqual([
			["dns-site", "passed"],
			["dns-preview", "passed"],
			["reach-site", "passed"],
			["reach-preview", "passed"],
		]);
		// The new name is not served yet, so the nonce goes to its addresses under the current one.
		expect(
			net.urls.every((u) =>
				u.startsWith(
					"https://portikus.example.edu:8443/.well-known/portikus-preflight/",
				),
			),
		).toBe(true);
	});

	test("refuses a new name whose DNS points at another server", async () => {
		const { result } = await run((name) =>
			name === "code.example.edu" ? [ELSEWHERE] : [THIS_SERVER],
		);
		expect(result.ok).toBe(false);
		const site = result.checks.find((c) => c.name === "reach-site");
		expect(site?.result).toBe("failed");
		expect(site?.message).toContain("code.example.edu does not point at this server");
	});

	test("refuses when only one of the name's addresses is this server", async () => {
		const { result } = await run(() => [THIS_SERVER, ELSEWHERE]);
		expect(result.ok).toBe(false);
	});

	test("refuses names that do not resolve, naming the wildcard to add", async () => {
		const { result } = await run(() => []);
		expect(result.ok).toBe(false);
		expect(result.checks.every((c) => c.result === "failed")).toBe(true);
		expect(result.checks.find((c) => c.name === "dns-preview")?.message).toContain(
			"*.preview.code.example.edu",
		);
	});
});
