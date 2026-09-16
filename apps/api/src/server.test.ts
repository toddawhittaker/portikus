import * as http from "node:http";
import type { AddressInfo } from "node:net";
import type { OidcClient } from "@portikus/auth";
import { HealthResponse } from "@portikus/contracts";
import type { Database } from "@portikus/db";
import type { Kysely } from "kysely";
import { expect, test, vi } from "vitest";
import { buildServer } from "./server.js";
import { PUBLIC_URL, testConfig } from "./test-support.js";

/** Minimal stub: the health route does not touch the database. */
function makeApp(oidc?: OidcClient) {
	return buildServer({
		db: {} as unknown as Kysely<Database>,
		config: testConfig("http://127.0.0.1:3002"),
		oidc,
	});
}

test("GET /health returns a valid HealthResponse", async () => {
	const app = makeApp();
	const response = await app.inject({ method: "GET", url: "/health" });

	expect(response.statusCode).toBe(200);
	const body = HealthResponse.parse(response.json());
	expect(body.service).toBe("api");

	await app.close();
});

test("GET /health is served as JSON", async () => {
	const app = makeApp();
	const response = await app.inject({ method: "GET", url: "/health" });

	expect(response.headers["content-type"]).toMatch(/^application\/json/);
	expect(HealthResponse.safeParse(JSON.parse(response.body)).success).toBe(true);

	await app.close();
});

test("GET /health reports a non-negative uptime and the ok status", async () => {
	const app = makeApp();
	const body = HealthResponse.parse(
		(await app.inject({ method: "GET", url: "/health" })).json(),
	);

	expect(body.status).toBe("ok");
	expect(body.uptimeSeconds).toBeGreaterThanOrEqual(0);

	await app.close();
});

test("an unknown route needs a session before it is even 404", async () => {
	const app = makeApp();
	const response = await app.inject({ method: "GET", url: "/not-a-route" });

	// Access is denied by default, so an anonymous request is 401 (SPEC.md §5.2).
	expect(response.statusCode).toBe(401);

	await app.close();
});

test("POST /health is not allowed", async () => {
	const app = makeApp();
	const response = await app.inject({ method: "POST", url: "/health" });

	expect(response.statusCode).not.toBe(200);

	await app.close();
});

test("an unexpected error returns a generic INTERNAL body", async () => {
	const failing: OidcClient = {
		buildLoginRedirect: async () => {
			throw new Error("discovery exploded at postgres://secret@host/db");
		},
		completeLogin: async () => {
			throw new Error("unused");
		},
	};
	const app = makeApp(failing);
	const logged = vi.spyOn(console, "error").mockImplementation(() => {});
	const response = await app.inject({ method: "GET", url: "/auth/login" });

	expect(response.statusCode).toBe(500);
	expect(response.json().code).toBe("INTERNAL");
	expect(response.body).not.toContain("postgres://");
	expect(logged).toHaveBeenCalled();

	logged.mockRestore();
	await app.close();
});

/** One keep-alive request, resolving with the status and the local port used. */
function request(
	port: number,
	agent: http.Agent,
	headers: Record<string, string>,
): Promise<{ status: number; localPort: number | undefined }> {
	return new Promise((resolve, reject) => {
		const req = http.request(
			{ host: "127.0.0.1", port, path: "/health", agent, headers },
			(res) => {
				const localPort = res.socket.localPort;
				res.resume();
				res.on("end", () => resolve({ status: res.statusCode ?? 0, localPort }));
			},
		);
		req.on("error", reject);
		req.end();
	});
}

test("an ordinary request with an Upgrade header keeps its connection", async () => {
	const app = makeApp();
	await app.listen({ port: 0, host: "127.0.0.1" });
	const port = (app.server.address() as AddressInfo).port;
	const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });

	try {
		const first = await request(port, agent, {
			upgrade: "websocket",
			origin: new URL(PUBLIC_URL).origin,
			connection: "keep-alive",
		});
		expect(first.status).toBe(200);

		const second = await request(port, agent, { connection: "keep-alive" });
		expect(second.status).toBe(200);
		expect(second.localPort).toBe(first.localPort);
	} finally {
		agent.destroy();
		await app.close();
	}
});

test("a refused upgrade does not hold shutdown open", async () => {
	const app = makeApp();
	await app.listen({ port: 0, host: "127.0.0.1" });
	const port = (app.server.address() as AddressInfo).port;
	const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });

	const refused = await request(port, agent, {
		upgrade: "websocket",
		origin: "https://evil.example.com",
		connection: "keep-alive",
	});
	expect(refused.status).toBe(403);

	const started = Date.now();
	await app.close();
	agent.destroy();
	expect(Date.now() - started).toBeLessThan(2_000);
});
