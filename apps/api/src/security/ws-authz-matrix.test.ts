import type { AddressInfo } from "node:net";
import { type MockOidcProvider, startMockOidcProvider } from "@portikus/auth/testing";
import { createTestDb, hasTestDb, type TestDb } from "@portikus/db/testing";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import WebSocket from "ws";
import { type FakeAgent, startFakeAgent } from "../fake-agent.js";
import {
	buildMatrixWorld,
	buildTestServer,
	MATRIX_MOCK_USERS,
	type MatrixWorld,
	PUBLIC_URL,
} from "../test-support.js";
import { ROUTE_POLICY, splitKey } from "./route-policy.js";

/**
 * The browser sockets of the authorization matrix (Epic 12a, Done items 3
 * to 5; SPEC.md sections 5.3, 5.4, 20.2, 24.3). A refused socket is refused
 * with an HTTP status before the upgrade, and the agent never hears of it.
 */

const skip = !hasTestDb();
if (skip && process.env.CI) {
	throw new Error("the authorization matrix must run in CI: set TEST_DATABASE_URL");
}

const AGENT_TOKEN = "ws-matrix-agent-token";
const PUBLIC_ORIGIN = new URL(PUBLIC_URL).origin;

let testDb: TestDb;
let mock: MockOidcProvider;
let agent: FakeAgent;

beforeAll(async () => {
	if (skip) return;
	testDb = await createTestDb();
	mock = await startMockOidcProvider({
		users: MATRIX_MOCK_USERS,
	});
	agent = await startFakeAgent(AGENT_TOKEN);
});

afterAll(async () => {
	if (skip) return;
	await testDb.close();
	await mock.close();
	await agent.close();
});

async function withWorld(
	run: (app: FastifyInstance, world: MatrixWorld) => Promise<void>,
): Promise<void> {
	await testDb.truncate();
	const app = buildTestServer(testDb.db, mock.issuer, { AGENT_PORT: agent.port });
	await app.listen({ port: 0, host: "127.0.0.1" });
	try {
		await run(app, await buildMatrixWorld(app, testDb.db, AGENT_TOKEN));
	} finally {
		await app.close();
	}
}

function agentCalls(): string[] {
	return agent.requests
		.filter((one) => !one.url.startsWith("/listening/events"))
		.map((one) => `${one.method} ${one.url}`);
}

/**
 * Try the upgrade. Resolves 101 when the socket opened (and closes it), or
 * the HTTP status the server refused it with.
 */
async function upgrade(
	app: FastifyInstance,
	path: string,
	headers: Record<string, string>,
): Promise<{ status: number; calls: string[] }> {
	const before = agentCalls().length;
	const { port } = app.server.address() as AddressInfo;
	const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers });
	const status = await new Promise<number>((resolve) => {
		socket.once("open", () => {
			socket.close();
			resolve(101);
		});
		socket.once("unexpected-response", (_request, response) => {
			resolve(response.statusCode ?? 0);
			socket.terminate();
		});
		socket.once("error", () => resolve(0));
	});
	return { status, calls: agentCalls().slice(before) };
}

function pathFor(
	pattern: string,
	ids: { workspaceId: string; projectId: string; terminalId: string },
): string {
	return pattern
		.replace(":id", ids.workspaceId)
		.replace(":pid", ids.projectId)
		.replace(":tid", ids.terminalId)
		.replace(":checkId", "lint");
}

const socketKeys = Object.keys(ROUTE_POLICY).filter(
	(key) => ROUTE_POLICY[key]?.websocket && key.startsWith("GET "),
);

test("the four browser sockets are all in the matrix", () => {
	expect(socketKeys).toHaveLength(4);
});

describe.skipIf(skip)("every browser socket refuses the wrong caller", () => {
	for (const key of socketKeys) {
		const { url: pattern } = splitKey(key);
		const access = ROUTE_POLICY[key]?.access;

		test(`${key} (${access})`, () =>
			withWorld(async (app, world) => {
				const path = pathFor(pattern, world.a);
				const cookieA = world.a.jar.cookieHeader();
				const refusals: Array<[string, Record<string, string>, number]> = [
					["anonymous", { origin: PUBLIC_ORIGIN }, 401],
					[
						"the disabled user",
						{ origin: PUBLIC_ORIGIN, cookie: world.disabled.cookieHeader() },
						401,
					],
					[
						"A's agent token with no cookie",
						{ origin: PUBLIC_ORIGIN, authorization: `Bearer ${world.a.agentToken}` },
						401,
					],
					[
						"student B",
						{ origin: PUBLIC_ORIGIN, cookie: world.b.jar.cookieHeader() },
						404,
					],
					[
						"an instructor of A's course",
						{ origin: PUBLIC_ORIGIN, cookie: world.instructor.cookieHeader() },
						404,
					],
					["A with no Origin", { cookie: cookieA }, 403],
					[
						"A from a preview Origin",
						{
							cookie: cookieA,
							origin: `https://${world.a.label}-5173.preview.localhost`,
						},
						403,
					],
				];
				if (access === "owner") {
					refusals.push([
						"the administrator",
						{ origin: PUBLIC_ORIGIN, cookie: world.admin.cookieHeader() },
						404,
					]);
				}
				for (const [who, headers, status] of refusals) {
					const result = await upgrade(app, path, headers);
					expect(result.status, `${key} for ${who}`).toBe(status);
					expect(result.calls, `${key} for ${who} reached the agent`).toEqual([]);
				}

				// The right caller does get through: the refusals above are not
				// just a broken route.
				const allowed = [cookieA];
				if (access === "owner-or-admin") allowed.push(world.admin.cookieHeader());
				for (const cookie of allowed) {
					const result = await upgrade(app, path, { origin: PUBLIC_ORIGIN, cookie });
					expect(
						result.status === 101 || result.calls.length > 0,
						`${key} for its owner answered ${result.status}`,
					).toBe(true);
				}
			}));
	}
});

describe.skipIf(skip)("a socket with A's workspace and B's child id is a 404", () => {
	for (const key of socketKeys.filter((one) => /:(pid|tid)/.test(one))) {
		test(key, () =>
			withWorld(async (app, world) => {
				const path = pathFor(splitKey(key).url, {
					workspaceId: world.a.workspaceId,
					projectId: world.b.projectId,
					terminalId: world.b.terminalId,
				});
				const result = await upgrade(app, path, {
					origin: PUBLIC_ORIGIN,
					cookie: world.a.jar.cookieHeader(),
				});
				expect(result.status).toBe(404);
				expect(result.calls).toEqual([]);
			}),
		);
	}
});
