import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { createOidcClient, type OidcClient } from "@portikus/auth";
import {
	CookieJar,
	csrfHeaders,
	loginAs,
	type MockOidcProvider,
	startMockOidcProvider,
} from "@portikus/auth/testing";
import { HealthResponse } from "@portikus/contracts";
import type { Database } from "@portikus/db";
import { createTestDb, hasTestDb, type TestDb } from "@portikus/db/testing";
import { type LogLevel, silentLogger } from "@portikus/observability";
import { collectingLogger } from "@portikus/observability/testing";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { toAuthOptions } from "./auth-options.js";
import { buildServer } from "./server.js";
import { PUBLIC_URL, testConfig } from "./test-support.js";

/** Minimal stub: the health route does not touch the database. */
function makeApp(oidc?: OidcClient) {
	return buildServer({
		db: {} as unknown as Kysely<Database>,
		config: testConfig("http://127.0.0.1:3002"),
		logger: silentLogger(),
		oidc,
	});
}

/** Request lines only, in order. */
function requestLines(lines: Record<string, unknown>[]): Record<string, unknown>[] {
	return lines.filter((line) => line.msg === "request");
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
	const { logger, lines } = collectingLogger();
	const app = buildServer({
		db: {} as unknown as Kysely<Database>,
		config: testConfig("http://127.0.0.1:3002"),
		logger,
		oidc: failing,
	});
	const response = await app.inject({ method: "GET", url: "/auth/login" });

	expect(response.statusCode).toBe(500);
	expect(response.json().code).toBe("INTERNAL");
	expect(response.body).not.toContain("postgres://");
	expect(
		lines.some(
			(line) => line.level === "error" && line.msg === "unhandled request error",
		),
	).toBe(true);

	await app.close();
});

test("a busy database pool answers 503 SERVICE_BUSY (docs/EPIC-17.md ruling 14)", async () => {
	const busy: OidcClient = {
		buildLoginRedirect: async () => {
			throw new Error("timeout exceeded when trying to connect");
		},
		completeLogin: async () => {
			throw new Error("unused");
		},
	};
	const app = buildServer({
		db: {} as unknown as Kysely<Database>,
		config: testConfig("http://127.0.0.1:3002"),
		logger: silentLogger(),
		oidc: busy,
	});
	const response = await app.inject({ method: "GET", url: "/auth/login" });
	expect(response.statusCode).toBe(503);
	expect(response.json()).toEqual({
		code: "SERVICE_BUSY",
		message: "The server is busy. Try again in a moment.",
	});
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

// --- One line per request (ADR 0012, SPEC.md §25.6) ---

/** A stub-database server that writes its request lines into `lines`. */
function makeLoggingApp(level: LogLevel = "info") {
	const { logger, lines } = collectingLogger(level);
	const app = buildServer({
		db: {} as unknown as Kysely<Database>,
		config: testConfig("http://127.0.0.1:3002"),
		logger,
	});
	return { app, lines };
}

test("a refused request is logged at warn with its status and error code", async () => {
	const { app, lines } = makeLoggingApp();
	const response = await app.inject({ method: "GET", url: "/workspaces" });
	expect(response.statusCode).toBe(401);

	const [line] = requestLines(lines);
	expect(line?.level).toBe("warn");
	expect(line?.status).toBe(401);
	expect(line?.code).toBe("UNAUTHORIZED");
	expect(line?.path).toBe("/workspaces");

	await app.close();
});

test("a health poll writes no line at info and one at debug", async () => {
	const quiet = makeLoggingApp("info");
	await quiet.app.inject({ method: "GET", url: "/health" });
	expect(requestLines(quiet.lines)).toHaveLength(0);
	await quiet.app.close();

	const loud = makeLoggingApp("debug");
	await loud.app.inject({ method: "GET", url: "/health" });
	expect(requestLines(loud.lines)[0]?.level).toBe("debug");
	await loud.app.close();
});

// --- Naming the signed-in user needs a real session ---

const skip = !hasTestDb();
let testDb: TestDb;
let mock: MockOidcProvider;

beforeAll(async () => {
	if (skip) return;
	testDb = await createTestDb();
	mock = await startMockOidcProvider({
		redirectUris: [`${PUBLIC_URL}/auth/callback`],
	});
});

afterAll(async () => {
	if (skip) return;
	await testDb.close();
	await mock.close();
});

beforeEach(async () => {
	if (skip) return;
	await testDb.truncate();
});

test.skipIf(skip)("a request with a session names the user on its line", async () => {
	const { logger, lines } = collectingLogger();
	const config = testConfig(mock.issuer);
	const app = buildServer({
		db: testDb.db,
		config,
		logger,
		oidc: createOidcClient(toAuthOptions(config)),
	});
	await app.ready();

	const jar = new CookieJar();
	await loginAs(app, "alice", jar);
	const created = await app.inject({
		method: "POST",
		url: "/workspaces",
		headers: csrfHeaders(jar, PUBLIC_URL),
	});
	expect(created.statusCode).toBe(201);
	const response = await app.inject({
		method: "GET",
		url: `/workspaces/${created.json().id}`,
		headers: { cookie: jar.cookieHeader() },
	});
	expect(response.statusCode).toBe(200);

	const line = requestLines(lines).at(-1);
	expect(line?.level).toBe("info");
	expect(line?.status).toBe(200);
	expect(line?.workspaceId).toBe(created.json().id);
	expect(typeof line?.userId).toBe("string");
	// No cookie value ever reaches a line (SPEC.md §24.11).
	expect(JSON.stringify(lines)).not.toContain(jar.cookieHeader());

	await app.close();
});
