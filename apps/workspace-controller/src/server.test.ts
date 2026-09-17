import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, expect, test } from "vitest";
import { FakeWorkspaceProvider } from "./fake-provider.js";
import { buildServer } from "./server.js";

const TOKEN = "test-token-value";
const AGENT_TOKEN = "a".repeat(64);
let provider: FakeWorkspaceProvider;
let app: FastifyInstance;

beforeEach(() => {
	provider = new FakeWorkspaceProvider();
	app = buildServer({ provider, token: TOKEN });
});

afterEach(async () => {
	await app.close();
});

function auth() {
	return { authorization: `Bearer ${TOKEN}` };
}

// Auth tests.

test("401 without token", async () => {
	const res = await app.inject({
		method: "POST",
		url: "/instances",
		payload: { name: "ws-a", homeGiB: 25, dockerGiB: 20 },
	});
	expect(res.statusCode).toBe(401);
	expect(res.json().code).toBe("UNAUTHORIZED");
});

test("401 with wrong-length token", async () => {
	const res = await app.inject({
		method: "POST",
		url: "/instances",
		payload: { name: "ws-a", homeGiB: 25, dockerGiB: 20 },
		headers: { authorization: "Bearer short" },
	});
	expect(res.statusCode).toBe(401);
});

test("401 with wrong token of same length", async () => {
	const res = await app.inject({
		method: "POST",
		url: "/instances",
		payload: { name: "ws-a", homeGiB: 25, dockerGiB: 20 },
		headers: { authorization: "Bearer wrong-token-valu" },
	});
	expect(res.statusCode).toBe(401);
});

test("GET /health does not require auth", async () => {
	const res = await app.inject({ method: "GET", url: "/health" });
	expect(res.statusCode).toBe(200);
	expect(res.json().service).toBe("workspace-controller");
});

test("a path that merely starts with /health still requires auth", async () => {
	const res = await app.inject({ method: "GET", url: "/healthz" });
	// No such route, so it is a 404 rather than a pass through the exemption.
	expect(res.statusCode).not.toBe(200);
});

test("GET /instances still requires auth", async () => {
	const res = await app.inject({ method: "GET", url: "/instances" });
	expect(res.statusCode).toBe(401);
});

// POST /instances

test("create instance happy path", async () => {
	const res = await app.inject({
		method: "POST",
		url: "/instances",
		headers: auth(),
		payload: { name: "ws-abc", homeGiB: 25, dockerGiB: 20 },
	});
	expect(res.statusCode).toBe(201);
	expect(res.json().created).toBe(true);
});

test("create instance already exists returns 200", async () => {
	await app.inject({
		method: "POST",
		url: "/instances",
		headers: auth(),
		payload: { name: "ws-abc", homeGiB: 25, dockerGiB: 20 },
	});
	const res = await app.inject({
		method: "POST",
		url: "/instances",
		headers: auth(),
		payload: { name: "ws-abc", homeGiB: 25, dockerGiB: 20 },
	});
	expect(res.statusCode).toBe(200);
	expect(res.json().created).toBe(false);
});

test("create with invalid name returns 400", async () => {
	const res = await app.inject({
		method: "POST",
		url: "/instances",
		headers: auth(),
		payload: { name: "INVALID!", homeGiB: 25, dockerGiB: 20 },
	});
	expect(res.statusCode).toBe(400);
	expect(res.json().code).toBe("INVALID_NAME");
});

// POST /instances/:name/start

test("start happy path", async () => {
	await app.inject({
		method: "POST",
		url: "/instances",
		headers: auth(),
		payload: { name: "ws-abc", homeGiB: 25, dockerGiB: 20 },
	});
	const res = await app.inject({
		method: "POST",
		url: "/instances/ws-abc/start",
		headers: auth(),
		payload: { timeoutSeconds: 10, agentToken: AGENT_TOKEN },
	});
	expect(res.statusCode).toBe(200);
	expect(res.json().ipv4).toBe("10.0.0.2");
});

test("start not found returns 404", async () => {
	const res = await app.inject({
		method: "POST",
		url: "/instances/ws-missing/start",
		headers: auth(),
		payload: { timeoutSeconds: 10, agentToken: AGENT_TOKEN },
	});
	expect(res.statusCode).toBe(404);
});

test("start with invalid name returns 400", async () => {
	const res = await app.inject({
		method: "POST",
		url: "/instances/BAD!/start",
		headers: auth(),
		payload: {},
	});
	expect(res.statusCode).toBe(400);
});

// POST /instances/:name/stop

test("stop happy path", async () => {
	await app.inject({
		method: "POST",
		url: "/instances",
		headers: auth(),
		payload: { name: "ws-abc", homeGiB: 25, dockerGiB: 20 },
	});
	await app.inject({
		method: "POST",
		url: "/instances/ws-abc/start",
		headers: auth(),
		payload: { agentToken: AGENT_TOKEN },
	});
	const res = await app.inject({
		method: "POST",
		url: "/instances/ws-abc/stop",
		headers: auth(),
		payload: { timeoutSeconds: 5 },
	});
	expect(res.statusCode).toBe(200);
	expect(res.json().forced).toBe(false);
});

test("stop with forced path", async () => {
	await app.inject({
		method: "POST",
		url: "/instances",
		headers: auth(),
		payload: { name: "ws-abc", homeGiB: 25, dockerGiB: 20 },
	});
	provider.setStopHangs(true);
	const res = await app.inject({
		method: "POST",
		url: "/instances/ws-abc/stop",
		headers: auth(),
		payload: { timeoutSeconds: 5 },
	});
	expect(res.statusCode).toBe(200);
	expect(res.json().forced).toBe(true);
});

// GET /instances

test("list instances", async () => {
	await app.inject({
		method: "POST",
		url: "/instances",
		headers: auth(),
		payload: { name: "ws-abc", homeGiB: 25, dockerGiB: 20 },
	});
	const res = await app.inject({
		method: "GET",
		url: "/instances",
		headers: auth(),
	});
	expect(res.statusCode).toBe(200);
	const list = res.json();
	expect(list).toHaveLength(1);
	expect(list[0].name).toBe("ws-abc");
});

// Provider error mapping.

test("INCUS_UNAVAILABLE maps to 503", async () => {
	provider.failNext("INCUS_UNAVAILABLE");
	const res = await app.inject({
		method: "GET",
		url: "/instances",
		headers: auth(),
	});
	expect(res.statusCode).toBe(503);
});

// Single-flight.

test("two concurrent starts cause one provider call", async () => {
	let startCount = 0;
	const original = provider.start.bind(provider);
	provider.start = async (name, opts) => {
		startCount++;
		// Add a small delay to ensure both requests arrive.
		await new Promise((r) => setTimeout(r, 50));
		return original(name, opts);
	};

	await app.inject({
		method: "POST",
		url: "/instances",
		headers: auth(),
		payload: { name: "ws-abc", homeGiB: 25, dockerGiB: 20 },
	});

	const [r1, r2] = await Promise.all([
		app.inject({
			method: "POST",
			url: "/instances/ws-abc/start",
			headers: auth(),
			payload: { timeoutSeconds: 10, agentToken: AGENT_TOKEN },
		}),
		app.inject({
			method: "POST",
			url: "/instances/ws-abc/start",
			headers: auth(),
			payload: { timeoutSeconds: 10, agentToken: AGENT_TOKEN },
		}),
	]);

	expect(r1.statusCode).toBe(200);
	expect(r2.statusCode).toBe(200);
	expect(startCount).toBe(1);
});
