import { HealthResponse } from "@portikus/contracts";
import type { Database } from "@portikus/db";
import type { Kysely } from "kysely";
import { expect, test, vi } from "vitest";
import { buildServer } from "./server.js";

/** Minimal stub: health route does not touch the database. */
function makeApp() {
	return buildServer({
		db: {} as unknown as Kysely<Database>,
		config: {
			NODE_ENV: "test",
			PORT: 3000,
			DATABASE_URL: "postgres://unused",
			PRESENCE_TTL_SECONDS: 60,
			WORKSPACE_HOME_SIZE_GIB: 25,
			WORKSPACE_DOCKER_SIZE_GIB: 20,
		},
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

test("an unknown route returns 404", async () => {
	const app = makeApp();
	const response = await app.inject({ method: "GET", url: "/not-a-route" });

	expect(response.statusCode).toBe(404);

	await app.close();
});

test("POST /health is not allowed", async () => {
	const app = makeApp();
	const response = await app.inject({ method: "POST", url: "/health" });

	expect(response.statusCode).not.toBe(200);

	await app.close();
});

test("an unexpected error returns a generic INTERNAL body", async () => {
	// The stub db has no query builder, so the route throws.
	const app = makeApp();
	const logged = vi.spyOn(console, "error").mockImplementation(() => {});
	const response = await app.inject({
		method: "GET",
		url: "/workspaces/8f7c2d1e-4b3a-4c5d-9e2f-1a2b3c4d5e6f",
	});

	expect(response.statusCode).toBe(500);
	expect(response.json().code).toBe("INTERNAL");
	expect(response.body).not.toContain("selectFrom");
	expect(logged).toHaveBeenCalled();

	logged.mockRestore();
	await app.close();
});
