import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test } from "vitest";

// No static import of outbound-fetch, so the slots are read before it loads.
test("importing outbound-fetch and a proxied request leave the global fetch dispatcher alone", async () => {
	const keys = [
		Symbol.for("undici.globalDispatcher.1"),
		Symbol.for("undici.globalDispatcher.2"),
	];
	const slots = globalThis as unknown as Record<symbol, unknown>;
	const before = keys.map((key) => [key in slots, slots[key]]);

	const proxy = http.createServer((_req, res) => {
		res.writeHead(200, { "content-type": "application/json" }).end("{}");
	});
	await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
	try {
		const { createOutboundFetch } = await import("./outbound-fetch.js");
		const port = (proxy.address() as AddressInfo).port;
		const outbound = createOutboundFetch(`http://127.0.0.1:${port}`);
		const response = await outbound("http://idp.invalid/jwks", {});
		expect(await response.json()).toEqual({});
	} finally {
		proxy.closeAllConnections();
		await new Promise((resolve) => proxy.close(resolve));
	}

	expect(keys.map((key) => [key in slots, slots[key]])).toEqual(before);
});
