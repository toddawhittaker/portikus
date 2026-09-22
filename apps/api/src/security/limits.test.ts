import {
	CookieJar,
	csrfHeaders,
	loginAs,
	type MockOidcProvider,
	startMockOidcProvider,
} from "@portikus/auth/testing";
import { createTestDb, hasTestDb, type TestDb } from "@portikus/db/testing";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import WebSocketClient from "ws";
import { type FakeAgent, startFakeAgent } from "../fake-agent.js";
import { buildTestServer, PUBLIC_URL } from "../test-support.js";

/**
 * The API's size and rate limits at its own edge (SPEC.md §9.7, §24;
 * Epic 12a Done item 8): the 1 MiB frame limit on every browser socket, the
 * JSON body limit on every route that takes a body, and the documented
 * sign-in rate-limit gap.
 */

vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 });

const skip = !hasTestDb();
const AGENT_TOKEN = "limits-agent-token";
const MIB = 1024 * 1024;

let testDb: TestDb;
let mock: MockOidcProvider;
let agent: FakeAgent;
let app: FastifyInstance;
let alice: CookieJar;
let carol: CookieJar;
let workspaceId: string;
let projectId: string;
let terminalId: string;
/** Every `METHOD url` the API registered, seen through `onRoute`. */
let routes: { method: string; url: string }[];

beforeAll(async () => {
	if (skip) return;
	testDb = await createTestDb();
	mock = await startMockOidcProvider({
		redirectUris: [`${PUBLIC_URL}/auth/callback`],
	});
	agent = await startFakeAgent(AGENT_TOKEN);
});

afterAll(async () => {
	if (skip) return;
	await testDb.close();
	await mock.close();
	await agent.close();
});

beforeEach(async () => {
	if (skip) return;
	await testDb.truncate();
	app = buildTestServer(testDb.db, mock.issuer, { AGENT_PORT: agent.port });
	routes = [];
	app.addHook("onRoute", (route) => {
		const methods = Array.isArray(route.method) ? route.method : [route.method];
		for (const method of methods) routes.push({ method, url: route.url });
	});
	await app.listen({ port: 0, host: "127.0.0.1" });
	alice = new CookieJar();
	carol = new CookieJar();
	await loginAs(app, "alice", alice);
	await loginAs(app, "carol", carol);
	workspaceId = (
		await app.inject({
			method: "POST",
			url: "/workspaces",
			headers: csrfHeaders(alice, PUBLIC_URL),
		})
	).json().id;
	await testDb.db
		.updateTable("workspaces")
		.set({
			state: "running",
			agent_address: "127.0.0.1",
			agent_token: AGENT_TOKEN,
			updated_at: new Date().toISOString(),
		})
		.where("id", "=", workspaceId)
		.execute();
	projectId = (
		await testDb.db
			.insertInto("projects")
			.values({
				workspace_id: workspaceId,
				slug: "essay",
				name: "essay",
				path: "/home/student/projects/essay",
				source: "new",
			})
			.returning("id")
			.executeTakeFirstOrThrow()
	).id;
	terminalId = (
		await testDb.db
			.insertInto("terminals")
			.values({ workspace_id: workspaceId, name: "Terminal", cwd: "/home/student" })
			.returning("id")
			.executeTakeFirstOrThrow()
	).id;
	return async () => {
		await app.close();
	};
});

/** Fill a route pattern with this test's own ids. */
function fill(url: string): string {
	return url
		.replace(":id", workspaceId)
		.replace(":pid", projectId)
		.replace(":tid", terminalId)
		.replace(":checkId", "tests")
		.replace(":port", "5173")
		.replace(":userId", crypto.randomUUID());
}

/** Open a browser socket through the API as Alice. */
async function open(
	path: string,
): Promise<{ ws: WebSocketClient; closed: Promise<number> }> {
	const address = app.server.address();
	const port = typeof address === "object" && address ? address.port : 0;
	const ws = new WebSocketClient(`ws://127.0.0.1:${port}${path}`, {
		headers: { origin: new URL(PUBLIC_URL).origin, cookie: alice.cookieHeader() },
	});
	const closed = new Promise<number>((resolve) => ws.on("close", resolve));
	await new Promise<void>((resolve, reject) => {
		ws.on("open", () => resolve());
		ws.on("error", reject);
	});
	return { ws, closed };
}

const SOCKETS = [
	"/workspaces/:id/ws",
	"/workspaces/:id/terminals/:tid/ws?cols=80&rows=24",
	"/workspaces/:id/projects/:pid/events",
	"/workspaces/:id/projects/:pid/checks/:checkId/runs/current",
];

for (const pattern of SOCKETS) {
	test.skipIf(skip)(`a frame over 1 MiB closes ${pattern} with 1009`, async () => {
		const socket = await open(fill(pattern));
		socket.ws.send("x".repeat(MIB + 1));
		expect(await socket.closed).toBe(1009);
		expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
	});
}

/** Every route that parses a JSON body. The file write streams raw bytes and has its own cap test. */
function jsonBodyRoutes(): { method: string; url: string }[] {
	return routes.filter(
		(route) =>
			["POST", "PUT", "PATCH", "DELETE"].includes(route.method) &&
			!route.url.startsWith("/__portikus/") &&
			!(route.method === "PUT" && route.url.endsWith("/file")),
	);
}

async function sendOversized(route: { method: string; url: string }) {
	const jar = route.url.startsWith("/admin") ? carol : alice;
	return app.inject({
		method: route.method as "POST",
		url: fill(route.url),
		headers: { ...csrfHeaders(jar, PUBLIC_URL), "content-type": "application/json" },
		payload: JSON.stringify({ padding: "x".repeat(MIB) }),
	});
}

test.skipIf(skip)(
	"a JSON body over 1 MiB is refused on every route that takes one",
	async () => {
		const withBody = jsonBodyRoutes();
		expect(withBody.length).toBeGreaterThan(10);
		const accepted: string[] = [];
		for (const route of withBody) {
			const response = await sendOversized(route);
			if (response.statusCode < 400) accepted.push(`${route.method} ${route.url}`);
		}
		expect(accepted).toEqual([]);
		// A refused body never reaches the workspace agent.
		expect(agent.creates).toEqual([]);
		expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
	},
);

test.fails("KNOWN-VULN #401: an oversized JSON body is answered 413, not 500 (SPEC.md §27)", async () => {
	if (skip) throw new Error("needs a test database");
	const wrong: string[] = [];
	for (const route of jsonBodyRoutes()) {
		const response = await sendOversized(route);
		if (response.statusCode !== 413) wrong.push(`${route.method} ${route.url}`);
	}
	expect(wrong).toEqual([]);
});

test.fails("KNOWN-VULN #398: repeated sign-in attempts from one address are rate limited (SPEC.md §24)", async () => {
	if (skip) throw new Error("needs a test database");
	const statuses = new Set<number>();
	for (let attempt = 0; attempt < 200; attempt += 1) {
		const response = await app.inject({
			method: "GET",
			url: "/auth/login",
			remoteAddress: "203.0.113.7",
		});
		statuses.add(response.statusCode);
	}
	expect(statuses.has(429)).toBe(true);
});
