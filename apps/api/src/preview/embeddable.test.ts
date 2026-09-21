import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, test } from "vitest";
import {
	hostRefusalFrom,
	MAX_REFUSAL_BODY_BYTES,
	probeEmbeddable,
	verdictFromHeaders,
} from "./embeddable.js";

const PORTIKUS = "https://portikus.example.edu";

function headers(pairs: Record<string, string>): Headers {
	return new Headers(pairs);
}

test("an application with no framing headers may be embedded", () => {
	expect(verdictFromHeaders(headers({}), PORTIKUS)).toEqual({ embeddable: true });
});

test.each([
	["DENY", false],
	["deny", false],
	[" SAMEORIGIN ", false],
	["sameorigin", false],
	["ALLOWALL", true],
])("X-Frame-Options %s", (value, embeddable) => {
	const verdict = verdictFromHeaders(headers({ "x-frame-options": value }), PORTIKUS);
	expect(verdict.embeddable).toBe(embeddable);
	if (!embeddable) expect(verdict.reason).toBe("x-frame-options");
});

test.each([
	["frame-ancestors 'none'", false],
	["frame-ancestors 'self'", false],
	["frame-ancestors https://other.example", false],
	["frame-ancestors *", true],
	["frame-ancestors https://portikus.example.edu", true],
	["frame-ancestors http://portikus.example.edu", false],
	["default-src 'self'; frame-ancestors https://portikus.example.edu", true],
	["default-src 'self'; frame-ancestors 'none'", false],
	["default-src 'self'", true],
	["frame-ancestors", false],
	["frame-ancestors https:", false],
])("CSP %s", (value, embeddable) => {
	const verdict = verdictFromHeaders(
		headers({ "content-security-policy": value }),
		PORTIKUS,
	);
	expect(verdict.embeddable).toBe(embeddable);
	if (!embeddable && !value.startsWith("default-src 'self'")) {
		expect(verdict.reason).toBe("frame-ancestors");
	}
});

test.each([
	// Undici joins repeated headers with a comma; every policy applies.
	["frame-ancestors https://portikus.example.edu, frame-ancestors 'none'", false],
	["frame-ancestors 'none', frame-ancestors https://portikus.example.edu", false],
	[
		"frame-ancestors https://portikus.example.edu, frame-ancestors https://portikus.example.edu",
		true,
	],
	["default-src 'self', frame-ancestors https://portikus.example.edu", true],
	[
		"frame-ancestors https://portikus.example.edu; report-uri /r, frame-ancestors 'self'",
		false,
	],
])("every frame-ancestors directive must allow us: %s", (value, embeddable) => {
	const verdict = verdictFromHeaders(
		headers({ "content-security-policy": value }),
		PORTIKUS,
	);
	expect(verdict.embeddable).toBe(embeddable);
	if (!embeddable) expect(verdict.reason).toBe("frame-ancestors");
});

test.each([
	["ALLOWALL, DENY", false],
	["DENY, ALLOWALL", false],
	["allowall, sameorigin", false],
	["ALLOWALL, ALLOWALL", true],
])("X-Frame-Options joined with commas: %s", (value, embeddable) => {
	const verdict = verdictFromHeaders(headers({ "x-frame-options": value }), PORTIKUS);
	expect(verdict.embeddable).toBe(embeddable);
	if (!embeddable) expect(verdict.reason).toBe("x-frame-options");
});

test("a SAMEORIGIN application is refused even though it allows its own origin", () => {
	// The preview runs on its own host, so the Portikus page is never the
	// application's origin (BROWSER-HANDLING.md §12).
	const verdict = verdictFromHeaders(
		headers({ "x-frame-options": "SAMEORIGIN" }),
		PORTIKUS,
	);
	expect(verdict).toEqual({ embeddable: false, reason: "x-frame-options" });
});

// ── The probe itself, against a real HTTP server ──

let server: Server | null = null;

async function listen(
	handler: (
		method: string,
		url: string,
		host: string,
	) => { status: number; headers: Record<string, string>; body?: string },
): Promise<string> {
	server = createServer((request, response) => {
		const answer = handler(
			request.method ?? "GET",
			request.url ?? "/",
			request.headers.host ?? "",
		);
		response.writeHead(answer.status, answer.headers);
		response.end(answer.body ?? "");
	});
	await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	return `127.0.0.1:${port}`;
}

afterEach(async () => {
	if (server) await new Promise((resolve) => server?.close(resolve));
	server = null;
});

test("the probe reads the framing headers of a live application", async () => {
	const seen: string[] = [];
	const upstream = await listen((method) => {
		seen.push(method);
		return { status: 200, headers: { "x-frame-options": "DENY" } };
	});
	await expect(probeEmbeddable(upstream, PORTIKUS)).resolves.toEqual({
		embeddable: false,
		reason: "x-frame-options",
	});
	expect(seen).toEqual(["HEAD"]);
});

test("an application that refuses HEAD is asked with GET instead", async () => {
	const seen: string[] = [];
	const upstream = await listen((method) => {
		seen.push(method);
		if (method === "HEAD")
			return { status: 405, headers: {} as Record<string, string> };
		return {
			status: 200,
			headers: { "content-security-policy": "frame-ancestors 'none'" },
			body: "secret source code",
		};
	});
	await expect(probeEmbeddable(upstream, PORTIKUS)).resolves.toEqual({
		embeddable: false,
		reason: "frame-ancestors",
	});
	expect(seen).toEqual(["HEAD", "GET"]);
});

test("the probe never returns any of the application's content", async () => {
	const upstream = await listen(() => ({
		status: 200,
		headers: { "content-type": "text/html" },
		body: "<h1>the student's page</h1>",
	}));
	const verdict = await probeEmbeddable(upstream, PORTIKUS);
	expect(verdict).toEqual({ embeddable: true });
	expect(JSON.stringify(verdict)).not.toContain("student");
});

test.each([400, 403, 404, 500, 503])(
	"a HEAD answered with %i is retried with GET",
	async (status) => {
		const seen: string[] = [];
		const upstream = await listen((method) => {
			seen.push(method);
			if (method === "HEAD") return { status, headers: {} as Record<string, string> };
			return {
				status: 200,
				headers: { "x-frame-options": "DENY" },
				body: "the student's page",
			};
		});
		await expect(probeEmbeddable(upstream, PORTIKUS)).resolves.toEqual({
			embeddable: false,
			reason: "x-frame-options",
		});
		expect(seen).toEqual(["HEAD", "GET"]);
	},
);

test("both attempts together take no longer than the probe budget", async () => {
	// The server answers HEAD with a 405 at once and then never answers the
	// GET, so a per-attempt budget would take twice as long as one budget.
	const slow = createServer((request, response) => {
		if (request.method === "HEAD") {
			response.writeHead(405);
			response.end();
			return;
		}
		// Never answered.
	});
	await new Promise<void>((resolve) => slow.listen(0, "127.0.0.1", resolve));
	const { port } = slow.address() as AddressInfo;
	const started = Date.now();
	try {
		await expect(probeEmbeddable(`127.0.0.1:${port}`, PORTIKUS)).resolves.toEqual({
			embeddable: false,
			reason: "unreachable",
		});
	} finally {
		slow.closeAllConnections();
		await new Promise((resolve) => slow.close(resolve));
	}
	expect(Date.now() - started).toBeLessThan(5_000);
});

test("an application that cannot be reached is reported as unreachable", async () => {
	// Port 1 on loopback has nothing listening.
	await expect(probeEmbeddable("127.0.0.1:1", PORTIKUS)).resolves.toEqual({
		embeddable: false,
		reason: "unreachable",
	});
});

// ── A development server that refuses the preview host (issue #262) ──

const REFUSED_HOST = "alice-5173.preview.portikus.example.edu";

const VITE_BODY =
	`Blocked request. This host ("${REFUSED_HOST}") is not allowed.\n` +
	`To allow this host, add "${REFUSED_HOST}" to \`server.allowedHosts\` in ` +
	"vite.config.js.";

test.each([
	[403, VITE_BODY, "vite"],
	[403, "Invalid Host header", "webpack-dev-server"],
	[403, "Invalid Host/Origin header", "webpack-dev-server"],
	// The message only counts when the server refused the request.
	[200, VITE_BODY, null],
	// An ordinary forbidden page is not a refused host.
	[403, "<h1>Forbidden</h1>", null],
	[403, "you may not read this file", null],
])("host refusal from %i %s", (status, body, server) => {
	expect(hostRefusalFrom(status, body)).toBe(server);
});

test("a dev server refusing the preview host is reported with the host", async () => {
	const hosts: string[] = [];
	const upstream = await listen((_method, _url, host) => {
		hosts.push(host);
		return { status: 403, headers: { "content-type": "text/html" }, body: VITE_BODY };
	});
	await expect(probeEmbeddable(upstream, PORTIKUS, REFUSED_HOST)).resolves.toEqual({
		embeddable: false,
		reason: "host-refused",
		refusedHost: REFUSED_HOST,
		refusedServer: "vite",
	});
	// The application must have been asked as the preview host, or a server
	// that only refuses unknown hosts would have answered normally.
	expect(hosts).toEqual([REFUSED_HOST, REFUSED_HOST]);
});

test("a plain 403 that is not about the host stays an ordinary verdict", async () => {
	const upstream = await listen(() => ({
		status: 403,
		headers: { "x-frame-options": "DENY" },
		body: "the student's secret page",
	}));
	const verdict = await probeEmbeddable(upstream, PORTIKUS, REFUSED_HOST);
	expect(verdict).toEqual({ embeddable: false, reason: "x-frame-options" });
	expect(JSON.stringify(verdict)).not.toContain("secret");
});

test("only the first bytes of a refusing answer are read", async () => {
	const upstream = await listen(() => ({
		status: 403,
		headers: { "content-type": "text/html" },
		// The message sits past the cap, so it is not seen.
		body: `${"x".repeat(MAX_REFUSAL_BODY_BYTES + 100)}${VITE_BODY}`,
	}));
	const verdict = await probeEmbeddable(upstream, PORTIKUS, REFUSED_HOST);
	expect(verdict.reason).not.toBe("host-refused");
});
