/**
 * The search route's failure and cancel paths (SPEC.md §11.5, §27), with
 * ripgrep replaced so the route alone is under test.
 */
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, expect, test, vi } from "vitest";

const calls: { signal?: AbortSignal }[] = [];

vi.mock("./search.js", () => ({
	searchProject: vi.fn(
		async (
			_home: string,
			slug: string,
			_q: string,
			options: { signal?: AbortSignal },
		) => {
			calls.push(options);
			if (slug === "broken") throw new Error("rg exploded at /home/u/secret");
			// Runs until the caller goes away.
			return new Promise((_resolve, reject) => {
				options.signal?.addEventListener("abort", () => reject(new Error("aborted")));
			});
		},
	),
}));

const { registerSearchRoutes } = await import("./search-routes.js");

let app: FastifyInstance | null = null;

afterEach(async () => {
	await app?.close();
	app = null;
	calls.length = 0;
});

async function build(): Promise<FastifyInstance> {
	app = Fastify();
	registerSearchRoutes(app, "/nowhere");
	await app.ready();
	return app;
}

test("an unexpected search failure is INTERNAL, not a terminal error", async () => {
	const server = await build();
	const response = await server.inject({
		method: "GET",
		url: "/projects/broken/search?q=x",
	});
	expect(response.statusCode).toBe(500);
	expect(response.json()).toEqual({
		error: { code: "INTERNAL", message: "internal error" },
	});
});

test("a caller that goes away aborts the search", async () => {
	const server = await build();
	await server.listen({ port: 0, host: "127.0.0.1" });
	const { port } = server.server.address() as AddressInfo;
	const client = httpRequest({
		host: "127.0.0.1",
		port,
		path: "/projects/demo/search?q=x",
	});
	client.on("error", () => {});
	client.end();
	await vi.waitFor(() => expect(calls).toHaveLength(1));
	expect(calls[0]?.signal?.aborted).toBe(false);
	client.destroy();
	await vi.waitFor(() => expect(calls[0]?.signal?.aborted).toBe(true));
});
