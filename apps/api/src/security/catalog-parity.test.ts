import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiKey } from "@portikus/auth";
import {
	type CookieJar,
	type MockOidcProvider,
	startMockOidcProvider,
} from "@portikus/auth/testing";
import type { ApiKeyScope } from "@portikus/contracts";
import { createTestDb, hasTestDb, type TestDb } from "@portikus/db/testing";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import WebSocket from "ws";
import { OPERATIONS, operationByKey } from "../catalog/index.js";
import { type RunResult, runOperation } from "../catalog/run.js";
import { ROUTE_POLICY, splitKey } from "../route-policy.js";
import { type FakeAgent, startFakeAgent } from "../testing/fake-agent/index.js";
import {
	type FakeBackupKey,
	fakeKey,
	startFakeBackupKey,
} from "../testing/fake-backup-key.js";
import { PAYLOADS, QUERIES } from "../testing/matrix-samples.js";
import {
	type Answer,
	answerOf,
	buildParityWorld,
	type CourseTarget,
	codeOf,
	fillPath,
	INSTRUCTOR,
	pathValues,
	userIdOf,
	type ParityWorld as World,
} from "../testing/parity-world.js";
import {
	buildTestServer,
	MATRIX_MOCK_USERS,
	PUBLIC_URL,
} from "../testing/test-support.js";

/**
 * Authorization parity for API keys (SPEC.md sections 24.1, 24.8 and 24.13).
 * A key acts as its holder and never as more: for every exposed operation, a
 * request with the key, sent over HTTP or through `runOperation`, gets the
 * answer the same request gets from the holder's browser session. A read key
 * is refused every change, and every route outside the catalog refuses keys.
 */

const skip = !hasTestDb();
if (skip && process.env.CI) {
	throw new Error("the catalog parity tests must run in CI: set TEST_DATABASE_URL");
}

const AGENT_TOKEN = "parity-agent-token";
const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const PUBLIC_ORIGIN = new URL(PUBLIC_URL).origin;
const ADMIN = "carol";
/** Routes every key may reach whatever its scope: the MCP and OpenAPI doors. */
const DOORS = new Set([
	"GET /mcp",
	"POST /mcp",
	"GET /openapi.json",
	"HEAD /openapi.json",
]);
/** Several worlds per test, so the default five seconds is too short. */
const TIMEOUT = 60_000;

let testDb: TestDb;
let mock: MockOidcProvider;
let agent: FakeAgent;
let keyHelper: FakeBackupKey;
let keyDir: string;
const PARITY_KEY = fakeKey("parity server");

beforeAll(async () => {
	if (skip) return;
	testDb = await createTestDb();
	mock = await startMockOidcProvider({ users: MATRIX_MOCK_USERS });
	agent = await startFakeAgent(AGENT_TOKEN);
	keyDir = mkdtempSync(join(tmpdir(), "catalog-parity-key-"));
	keyHelper = await startFakeBackupKey(join(keyDir, "helper.sock"), {
		identity: PARITY_KEY.identity,
		handedOut: null,
	});
});

afterAll(async () => {
	if (skip) return;
	await testDb.close();
	await mock.close();
	await agent.close();
	await keyHelper.close();
	rmSync(keyDir, { recursive: true, force: true });
});

/** A fresh server and world, so a change made by one caller cannot alter the next one's answer. */
async function withWorld(
	run: (app: FastifyInstance, world: World) => Promise<void>,
	options: { listen?: boolean } = {},
): Promise<void> {
	await testDb.truncate();
	keyHelper.setState({ identity: PARITY_KEY.identity, handedOut: null });
	const app = buildTestServer(testDb.db, mock.issuer, {
		AGENT_PORT: agent.port,
		BACKUP_KEY_SOCKET: keyHelper.socketPath,
	});
	if (options.listen) await app.listen({ port: 0, host: "127.0.0.1" });
	else await app.ready();
	try {
		const world = await buildParityWorld(app, testDb.db, AGENT_TOKEN);
		await run(app, world);
	} finally {
		await app.close();
	}
}

/** A fresh key for a matrix staff member. */
async function keyOf(subject: string, scope: ApiKeyScope): Promise<string> {
	const made = await createApiKey(testDb.db, await userIdOf(testDb.db, subject), {
		name: "Parity key",
		scope,
		periodDays: 30,
	});
	if (!made.ok) throw new Error(`no key for ${subject}: ${made.reason}`);
	return made.secret;
}

/** One request three ways: the session's cookie, the key over HTTP, and the key through the runner. */
type Channel = "session" | "key" | "runner";

async function ask(
	app: FastifyInstance,
	world: World,
	key: string,
	course: CourseTarget,
	channel: Channel,
	holder: { jar: CookieJar; secret: string },
): Promise<Answer> {
	const { method, url: pattern } = splitKey(key);
	const values = pathValues(key, world, course);
	const query = QUERIES[pattern] ?? "";
	const body = PAYLOADS[key];
	if (channel === "runner") {
		const operation = operationByKey(key);
		if (!operation) throw new Error(`${key} is not an operation`);
		const result: RunResult = await runOperation(
			app,
			testDb.db,
			{ kind: "api_key", apiKey: holder.secret, ip: "127.0.0.1" },
			operation.name,
			{
				path: values,
				query: Object.fromEntries(new URLSearchParams(query)),
				...(body === undefined ? {} : { body }),
			},
		);
		if (!result.ok)
			throw new Error(`the runner refused ${key}: ${result.error.message}`);
		return answerOf(result.status, result.body);
	}
	const headers: Record<string, string> =
		channel === "session"
			? {
					cookie: holder.jar.cookieHeader(),
					...(UNSAFE.has(method) ? { origin: PUBLIC_ORIGIN } : {}),
				}
			: { authorization: `Bearer ${holder.secret}` };
	const res: LightMyRequestResponse = await app.inject({
		method: method as "GET",
		url: `${fillPath(key, values)}${query}`,
		headers,
		...(body === undefined ? {} : { payload: body }),
	});
	return answerOf(res.statusCode, res.body);
}

interface Holder {
	name: string;
	subject: string;
	jar: (world: World) => CookieJar;
	course: (world: World) => CourseTarget;
}

const admin: Holder = {
	name: "administrator",
	subject: ADMIN,
	jar: (world) => world.admin,
	course: (world) => world.own,
};
const instructorOwn: Holder = {
	name: "instructor on their own course",
	subject: INSTRUCTOR,
	jar: (world) => world.instructor,
	course: (world) => world.own,
};
const instructorOther: Holder = {
	name: "instructor on another instructor's course",
	subject: INSTRUCTOR,
	jar: (world) => world.instructor,
	course: (world) => world.other,
};

function holdersFor(key: string): Holder[] {
	return key.includes(":courseId")
		? [admin, instructorOwn, instructorOther]
		: [admin, instructorOwn];
}

/** A key the gate let through: never a sign-in failure or a gate refusal. */
function expectPastTheGate(answer: Answer, why: string): void {
	expect(answer.status, why).not.toBe(401);
	expect(["NOT_AVAILABLE_TO_API_KEYS", "SCOPE_REQUIRED"], why).not.toContain(
		answer.code,
	);
}

const operationKeys = Object.keys(OPERATIONS);
const readKeys = operationKeys.filter((key) => OPERATIONS[key]?.risk === "read");
const changeKeys = operationKeys.filter((key) => OPERATIONS[key]?.risk !== "read");

test("the catalog has operations of each risk to compare", () => {
	expect(readKeys.length).toBeGreaterThan(20);
	expect(changeKeys.length).toBeGreaterThan(20);
});

describe.skipIf(skip)("a read gets the session's answer, with either scope", () => {
	for (const key of readKeys) {
		test(
			key,
			() =>
				withWorld(async (app, world) => {
					for (const holder of holdersFor(key)) {
						const jar = holder.jar(world);
						const course = holder.course(world);
						const session = await ask(app, world, key, course, "session", {
							jar,
							secret: "",
						});
						expect(session.status, `${key}: ${holder.name}'s session`).not.toBe(401);
						for (const scope of ["read", "destructive"] as const) {
							const secret = await keyOf(holder.subject, scope);
							for (const channel of ["key", "runner"] as const) {
								const why = `${key}: ${holder.name}, ${scope} key, ${channel}`;
								const answer = await ask(app, world, key, course, channel, {
									jar,
									secret,
								});
								expectPastTheGate(answer, why);
								expect(answer, why).toEqual(session);
							}
						}
					}
				}),
			TIMEOUT,
		);
	}
});

describe.skipIf(skip)(
	"a change gets the session's answer with a destructive key",
	() => {
		for (const key of changeKeys) {
			for (const holder of holdersFor(key)) {
				test(
					`${key} (${holder.name})`,
					async () => {
						// Each channel starts from an equal, fresh world, so a change one
						// made cannot alter what the next is told.
						const answers: Partial<Record<Channel, Answer>> = {};
						for (const channel of ["session", "key", "runner"] as const) {
							await withWorld(async (app, world) => {
								const secret =
									channel === "session"
										? ""
										: await keyOf(holder.subject, "destructive");
								answers[channel] = await ask(
									app,
									world,
									key,
									holder.course(world),
									channel,
									{ jar: holder.jar(world), secret },
								);
							});
						}
						expect(
							answers.session?.status,
							`${key}: ${holder.name}'s session`,
						).not.toBe(401);
						for (const channel of ["key", "runner"] as const) {
							const why = `${key}: ${holder.name}, ${channel}`;
							expectPastTheGate(answers[channel] as Answer, why);
							expect(answers[channel], why).toEqual(answers.session);
						}
					},
					TIMEOUT,
				);
			}
		}
	},
);

describe.skipIf(skip)("a read key is refused every change", () => {
	for (const key of changeKeys) {
		test(
			key,
			() =>
				withWorld(async (app, world) => {
					for (const holder of holdersFor(key)) {
						const secret = await keyOf(holder.subject, "read");
						for (const channel of ["key", "runner"] as const) {
							const answer = await ask(app, world, key, holder.course(world), channel, {
								jar: holder.jar(world),
								secret,
							});
							expect(answer, `${key}: ${holder.name}, ${channel}`).toEqual({
								status: 403,
								code: "SCOPE_REQUIRED",
							});
						}
					}
				}),
			TIMEOUT,
		);
	}
});

// --- Routes outside the catalog ------------------------------------

/**
 * Caddy's loopback questions, answered by hooks that run before sign-in and
 * so never look at a key: a key gets the anonymous answer, not the gate's
 * refusal (SPEC.md section 24.8).
 */
const ANSWERED_BEFORE_SIGN_IN = new Set([
	"GET /edge/signin-throttle",
	"HEAD /edge/signin-throttle",
	"GET /edge/certificate-ask",
	"HEAD /edge/certificate-ask",
	"GET /.well-known/portikus-preflight/:nonce",
	"HEAD /.well-known/portikus-preflight/:nonce",
]);

const unexposedKeys = Object.keys(ROUTE_POLICY).filter(
	(key) => !DOORS.has(key) && operationByKey(key) === undefined,
);
const socketKeys = unexposedKeys.filter(
	(key) => ROUTE_POLICY[key]?.websocket && key.startsWith("GET "),
);

test("every route outside the catalog and its doors is checked", () => {
	expect(unexposedKeys.length).toBeGreaterThan(150);
	expect(socketKeys.length).toBe(9);
});

/** The status of a real upgrade with this key, or 101 if the socket opened. */
async function upgradeStatus(
	app: FastifyInstance,
	path: string,
	secret: string,
): Promise<number> {
	const { port } = app.server.address() as AddressInfo;
	const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`, {
		headers: { origin: PUBLIC_ORIGIN, authorization: `Bearer ${secret}` },
	});
	return new Promise<number>((resolve) => {
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
}

/** What a key is told on a route outside the catalog. */
async function keyAnswerOutside(
	app: FastifyInstance,
	world: World,
	key: string,
	secret: string,
): Promise<Answer> {
	const { method } = splitKey(key);
	const res = await app.inject({
		method: method as "GET",
		url: fillPath(key, pathValues(key, world, world.own)),
		headers: { authorization: `Bearer ${secret}`, origin: PUBLIC_ORIGIN },
		...(PAYLOADS[key] === undefined ? {} : { payload: PAYLOADS[key] }),
	});
	// A HEAD answer has no body to read a code from.
	const code = method === "HEAD" ? "NOT_AVAILABLE_TO_API_KEYS" : codeOf(res.body);
	return { status: res.statusCode, code };
}

const REFUSED_TO_KEYS: Answer = { status: 403, code: "NOT_AVAILABLE_TO_API_KEYS" };

describe.skipIf(skip)(
	"a destructive key is refused every route outside the catalog",
	() => {
		test(
			"every unexposed route answers 403 NOT_AVAILABLE_TO_API_KEYS",
			() =>
				withWorld(
					async (app, world) => {
						const wrong: string[] = [];
						let secret = "";
						const checked = unexposedKeys.filter(
							(key) => !ANSWERED_BEFORE_SIGN_IN.has(key),
						);
						for (const [index, key] of checked.entries()) {
							// Stay well inside one key's per-minute limit.
							if (index % 100 === 0) secret = await keyOf(ADMIN, "destructive");
							const answer = await keyAnswerOutside(app, world, key, secret);
							if (answer.status !== 403 || answer.code !== REFUSED_TO_KEYS.code) {
								wrong.push(`${key} answered ${answer.status} ${answer.code}`);
							}
						}
						secret = await keyOf(INSTRUCTOR, "destructive");
						for (const key of socketKeys) {
							const path = fillPath(key, pathValues(key, world, world.own));
							const status = await upgradeStatus(app, path, secret);
							if (status !== 403) wrong.push(`${key} upgrade answered ${status}`);
						}
						expect(wrong).toEqual([]);
					},
					{ listen: true },
				),
			TIMEOUT * 2,
		);

		// These answer before sign-in, so a key gains nothing there: it is told
		// exactly what an anonymous caller is told (SPEC.md section 24.8).
		for (const key of ANSWERED_BEFORE_SIGN_IN) {
			test(
				`${key} gives a key exactly the anonymous answer`,
				() =>
					withWorld(async (app, world) => {
						const secret = await keyOf(ADMIN, "destructive");
						const { method } = splitKey(key);
						const url = `${fillPath(key, pathValues(key, world, world.own))}?domain=example.org`;
						for (const remoteAddress of ["127.0.0.1", "203.0.113.9"]) {
							const ask = (headers: Record<string, string>) =>
								app.inject({ method: method as "GET", url, remoteAddress, headers });
							const anonymous = await ask({});
							const keyed = await ask({ authorization: `Bearer ${secret}` });
							expect(
								{ status: keyed.statusCode, body: keyed.body },
								`${key} from ${remoteAddress}`,
							).toEqual({ status: anonymous.statusCode, body: anonymous.body });
						}
					}),
				TIMEOUT,
			);
		}
	},
);

test.skipIf(skip)("a student cannot hold a key", () =>
	withWorld(async (_app, world) => {
		const made = await createApiKey(testDb.db, world.a.userId, {
			name: "Student key",
			scope: "read",
			periodDays: 30,
		});
		expect(made).toEqual({ ok: false, reason: "not_staff" });
	}),
);
