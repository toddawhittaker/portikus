/**
 * Pre-flight (SPEC.md 20.1): failures block HTTP-01 and only warn for
 * DNS-01; a name passes only when the nonce comes back from every address.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { ApiConfig } from "@portikus/config";
import { afterEach, describe, expect, test } from "vitest";
import { NonceStore, type PreflightNet, runPreflight, systemNet } from "./preflight.js";

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
		() => new Promise<void>((done) => (server ? server.close(() => done()) : done())),
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

	test("answers null when nothing listens", async () => {
		expect(await systemNet.probe("http://site.invalid:1/x", "127.0.0.1")).toBeNull();
	});
});
