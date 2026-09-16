import type { OidcClient } from "@portikus/auth";
import { HealthResponse } from "@portikus/contracts";
import type { Database } from "@portikus/db";
import type { Kysely } from "kysely";
import { expect, test, vi } from "vitest";
import { buildServer } from "./server.js";
import { testConfig } from "./test-support.js";

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
