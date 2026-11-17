import type { AddressInfo } from "node:net";
import {
	type CookieJar,
	type MockOidcProvider,
	startMockOidcProvider,
} from "@portikus/auth/testing";
import { createTestDb, hasTestDb, type TestDb } from "@portikus/db/testing";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import WebSocket from "ws";
import { OPERATIONS, operationByKey } from "../catalog/index.js";
import { runOperation } from "../catalog/run.js";
import { ROUTE_POLICY, splitKey } from "../route-policy.js";
import { type FakeAgent, startFakeAgent } from "../testing/fake-agent/index.js";
import { PAYLOADS, QUERIES } from "../testing/matrix-samples.js";
import {
	type Answer,
	answerOf,
	buildParityWorld,
	type CourseTarget,
	fillPath,
	type ParityWorld,
	pathValues,
} from "../testing/parity-world.js";
import {
	buildTestServer,
	MATRIX_MOCK_USERS,
	PUBLIC_URL,
} from "../testing/test-support.js";
import { assistantTools, systemPrompt } from "./tools.js";

/**
 * The assistant acts as the signed-in person and never as more (SPEC.md
 * section 20.5): every exposed operation run through the assistant with a
 * person's session gets exactly the answer the same session gets over HTTP,
 * for each role. A student is refused every assistant route and the socket.
 */

const skip = !hasTestDb();
if (skip && process.env.CI) {
	throw new Error(
		"the assistant authorization tests must run in CI: set TEST_DATABASE_URL",
	);
}

const AGENT_TOKEN = "assistant-authz-agent-token";
const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const PUBLIC_ORIGIN = new URL(PUBLIC_URL).origin;
const TIMEOUT = 60_000;

let testDb: TestDb;
let mock: MockOidcProvider;
let agent: FakeAgent;

beforeAll(async () => {
	if (skip) return;
	testDb = await createTestDb();
	mock = await startMockOidcProvider({ users: MATRIX_MOCK_USERS });
	agent = await startFakeAgent(AGENT_TOKEN);
});

afterAll(async () => {
	if (skip) return;
	await testDb.close();
	await mock.close();
	await agent.close();
});

/** A fresh server and world, so a change one caller made cannot alter the next one's answer. */
async function withWorld(
	run: (app: FastifyInstance, world: ParityWorld) => Promise<void>,
	options: { listen?: boolean } = {},
): Promise<void> {
	await testDb.truncate();
	const app = buildTestServer(testDb.db, mock.issuer, { AGENT_PORT: agent.port });
	if (options.listen) await app.listen({ port: 0, host: "127.0.0.1" });
	else await app.ready();
	try {
		await run(app, await buildParityWorld(app, testDb.db, AGENT_TOKEN));
	} finally {
		await app.close();
	}
}

type Channel = "http" | "assistant";

interface Holder {
	name: string;
	jar: (world: ParityWorld) => CookieJar;
	course: (world: ParityWorld) => CourseTarget;
}

const HOLDERS: Holder[] = [
	{ name: "administrator", jar: (w) => w.admin, course: (w) => w.own },
	{
		name: "instructor teaching the course",
		jar: (w) => w.instructor,
		course: (w) => w.own,
	},
	{
		name: "instructor not teaching the course",
		jar: (w) => w.instructor,
		course: (w) => w.other,
	},
	{ name: "student", jar: (w) => w.a.jar, course: (w) => w.own },
];

/** Without a course in the path, the two instructor holders are the same caller. */
function holdersFor(key: string): Holder[] {
	return key.includes(":courseId") ? HOLDERS : HOLDERS.filter((_h, i) => i !== 2);
}

async function ask(
	app: FastifyInstance,
	world: ParityWorld,
	key: string,
	holder: Holder,
	channel: Channel,
): Promise<Answer> {
	const { method, url: pattern } = splitKey(key);
	const values = pathValues(key, world, holder.course(world));
	const query = QUERIES[pattern] ?? "";
	const body = PAYLOADS[key];
	const jar = holder.jar(world);
	if (channel === "assistant") {
		const operation = operationByKey(key);
		if (!operation) throw new Error(`${key} is not an operation`);
		const sessionToken = jar.get(app.sessionCookieName);
		if (!sessionToken) throw new Error(`${holder.name} has no session`);
		const result = await runOperation(
			app,
			testDb.db,
			{ kind: "assistant", sessionToken, ip: "127.0.0.1" },
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
	const res = await app.inject({
		method: method as "GET",
		url: `${fillPath(key, values)}${query}`,
		headers: {
			cookie: jar.cookieHeader(),
			...(UNSAFE.has(method) ? { origin: PUBLIC_ORIGIN } : {}),
		},
		...(body === undefined ? {} : { payload: body }),
	});
	return answerOf(res.statusCode, res.body);
}

const operationKeys = Object.keys(OPERATIONS);
const readKeys = operationKeys.filter((key) => OPERATIONS[key]?.risk === "read");
const changeKeys = operationKeys.filter((key) => OPERATIONS[key]?.risk !== "read");

test("the catalog has the course operations to compare", () => {
	expect(operationKeys).toContain("GET /courses/:courseId/stuck");
	expect(changeKeys.length).toBeGreaterThan(20);
});

describe.skipIf(skip)(
	"a read through the assistant gets the session's HTTP answer",
	() => {
		for (const key of readKeys) {
			test(
				key,
				() =>
					withWorld(async (app, world) => {
						for (const holder of holdersFor(key)) {
							const http = await ask(app, world, key, holder, "http");
							const assistant = await ask(app, world, key, holder, "assistant");
							expect(http.status, `${key}: ${holder.name} over HTTP`).not.toBe(401);
							expect(assistant, `${key}: ${holder.name}`).toEqual(http);
						}
					}),
				TIMEOUT,
			);
		}
	},
);

describe.skipIf(skip)(
	"a change through the assistant gets the session's HTTP answer",
	() => {
		for (const key of changeKeys) {
			for (const holder of holdersFor(key)) {
				test(
					`${key} (${holder.name})`,
					async () => {
						// Each channel starts from an equal, fresh world.
						const answers: Partial<Record<Channel, Answer>> = {};
						for (const channel of ["http", "assistant"] as const) {
							await withWorld(async (app, world) => {
								answers[channel] = await ask(app, world, key, holder, channel);
							});
						}
						expect(answers.http?.status, `${key}: ${holder.name} over HTTP`).not.toBe(
							401,
						);
						expect(answers.assistant, `${key}: ${holder.name}`).toEqual(answers.http);
					},
					TIMEOUT,
				);
			}
		}
	},
);

const assistantKeys = Object.keys(ROUTE_POLICY).filter(
	(key) => splitKey(key).url.startsWith("/assistant") && !key.startsWith("HEAD "),
);

/** The status of a real upgrade with this cookie, or 101 if the socket opened. */
async function upgradeStatus(
	app: FastifyInstance,
	path: string,
	cookie: string,
): Promise<number> {
	const { port } = app.server.address() as AddressInfo;
	const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`, {
		headers: { origin: PUBLIC_ORIGIN, cookie },
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

describe.skipIf(skip)("a student never gets the assistant", () => {
	test("the routes include the socket", () => {
		expect(assistantKeys.some((key) => ROUTE_POLICY[key]?.websocket)).toBe(true);
		expect(assistantKeys.length).toBeGreaterThan(3);
	});

	test(
		"every assistant route and the socket answer a student 403",
		() =>
			withWorld(
				async (app, world) => {
					const cookie = world.a.jar.cookieHeader();
					const wrong: string[] = [];
					for (const key of assistantKeys) {
						const { method } = splitKey(key);
						const url = fillPath(key, {
							id: "00000000-0000-4000-8000-000000000000",
						});
						if (ROUTE_POLICY[key]?.websocket) {
							const status = await upgradeStatus(app, url, cookie);
							if (status !== 403) wrong.push(`${key} upgrade answered ${status}`);
							continue;
						}
						const res = await app.inject({
							method: method as "GET",
							url,
							headers: {
								cookie,
								...(UNSAFE.has(method) ? { origin: PUBLIC_ORIGIN } : {}),
							},
							...(UNSAFE.has(method) && method !== "DELETE" ? { payload: {} } : {}),
						});
						if (res.statusCode !== 403) wrong.push(`${key} answered ${res.statusCode}`);
					}
					expect(wrong).toEqual([]);
				},
				{ listen: true },
			),
		TIMEOUT,
	);
});

describe("an instructor's assistant offers only what an instructor may run", () => {
	for (const readOnly of [false, true]) {
		test(`no administrator operation is a tool (read only: ${readOnly})`, () => {
			const { named } = assistantTools({ role: "instructor", readOnly });
			const audiences = [...named.values()].map(({ operation }) => operation.audience);
			expect(audiences).not.toContain("administrator");
			expect(named.has("courses_stuck")).toBe(true);
		});
	}

	test("a course conversation's prompt names the course and Who is stuck", () => {
		const courseId = "11111111-2222-4333-8444-555555555555";
		const prompt = systemPrompt(
			{ role: "instructor", readOnly: false, courseId },
			false,
		);
		expect(prompt).toContain(courseId);
		expect(prompt).toContain("courses_stuck");
		expect(systemPrompt({ role: "instructor", readOnly: false }, false)).not.toContain(
			"courses_stuck",
		);
	});
});
