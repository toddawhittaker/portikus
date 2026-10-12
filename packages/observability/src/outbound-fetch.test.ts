import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createOutboundFetch } from "./outbound-fetch.js";

// A forward proxy that refuses every request with an error page, as Squid
// does for a destination outside its allow-list.
let proxy: http.Server;
let proxyUrl: string;

beforeAll(async () => {
	proxy = http.createServer((req, res) => {
		req.resume();
		res.writeHead(403, { "content-type": "text/html" }).end("x".repeat(4000));
	});
	await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
	proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
});

afterAll(async () => {
	proxy.closeAllConnections();
	await new Promise((resolve) => proxy.close(resolve));
});

/** Let the response stream ask for data before the caller acts on it. */
async function settle(): Promise<void> {
	for (let i = 0; i < 5; i += 1) await null;
}

test("cancelling a refused response's body does not throw outside the caller", async () => {
	const uncaught: unknown[] = [];
	const record = (error: unknown) => uncaught.push(error);
	process.on("uncaughtException", record);
	try {
		const outbound = createOutboundFetch(proxyUrl);
		for (let i = 0; i < 3; i += 1) {
			const response = await outbound("http://lms.invalid/token", {
				method: "POST",
				headers: { "content-type": "application/x-www-form-urlencoded" },
				body: "grant_type=client_credentials",
			});
			expect(response.status).toBe(403);
			await settle();
			await response.body?.cancel();
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
	} finally {
		process.off("uncaughtException", record);
	}
	expect(uncaught).toEqual([]);
});

test("a refused response's body can still be read in full", async () => {
	const outbound = createOutboundFetch(proxyUrl);
	const response = await outbound("http://lms.invalid/token", {
		method: "POST",
		body: "a=b",
	});
	expect(response.status).toBe(403);
	expect(await response.text()).toBe("x".repeat(4000));
});
