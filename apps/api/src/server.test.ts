import { HealthResponse } from "@portikus/contracts";
import { expect, test } from "vitest";
import { buildServer } from "./server.js";

test("GET /health returns a valid HealthResponse", async () => {
	const app = buildServer();
	const response = await app.inject({ method: "GET", url: "/health" });

	expect(response.statusCode).toBe(200);
	const body = HealthResponse.parse(response.json());
	expect(body.service).toBe("api");

	await app.close();
});

test("GET /health is served as JSON", async () => {
	const app = buildServer();
	const response = await app.inject({ method: "GET", url: "/health" });

	expect(response.headers["content-type"]).toMatch(/^application\/json/);
	expect(HealthResponse.safeParse(JSON.parse(response.body)).success).toBe(true);

	await app.close();
});

test("GET /health reports a non-negative uptime and the ok status", async () => {
	const app = buildServer();
	const body = HealthResponse.parse(
		(await app.inject({ method: "GET", url: "/health" })).json(),
	);

	expect(body.status).toBe("ok");
	expect(body.uptimeSeconds).toBeGreaterThanOrEqual(0);

	await app.close();
});

test("an unknown route returns 404", async () => {
	const app = buildServer();
	const response = await app.inject({ method: "GET", url: "/not-a-route" });

	expect(response.statusCode).toBe(404);

	await app.close();
});

test("POST /health is not allowed", async () => {
	const app = buildServer();
	const response = await app.inject({ method: "POST", url: "/health" });

	expect(response.statusCode).not.toBe(200);

	await app.close();
});
