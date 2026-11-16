import {
	type CookieJar,
	csrfHeaders,
	type MockOidcProvider,
	startMockOidcProvider,
} from "@portikus/auth/testing";
import { ASSISTANT_MARK, type Database } from "@portikus/db";
import { createTestDb, hasTestDb, type TestDb } from "@portikus/db/testing";
import Fastify, { type FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "vitest";
import { type FakeAgent, startFakeAgent } from "../testing/fake-agent/index.js";
import {
	buildMatrixWorld,
	buildTestServer,
	MATRIX_MOCK_USERS,
	type MatrixWorld,
	PUBLIC_URL,
} from "../testing/test-support.js";
import { runOperation } from "./run.js";

/**
 * The in-process runner (SPEC.md sections 24.8 and 27): the URL comes only
 * from the catalog's pattern, every path value is encoded into one segment,
 * and the request carries the caller's own key and address.
 */

interface Seen {
	method: string;
	url: string;
	ip: string;
	authorization: string | undefined;
	userAgent: string | undefined;
	contentType: string | undefined;
	body: unknown;
}

let app: FastifyInstance;
/** The key path writes no row of its own, so it never touches the database. */
const NO_DB = {} as Kysely<Database>;
let seen: Seen[];
let rawHeaders: Record<string, unknown>[];

beforeEach(async () => {
	seen = [];
	rawHeaders = [];
	app = Fastify();
	app.decorate("sessionCookieName", "portikus_session");
	app.all("*", async (request) => {
		rawHeaders.push({ ...request.headers });
		seen.push({
			method: request.method,
			url: request.url,
			ip: request.ip,
			authorization: request.headers.authorization,
			userAgent: request.headers["user-agent"],
			contentType: request.headers["content-type"],
			body: request.body,
		});
		return { ok: true };
	});
	await app.ready();
});

afterEach(async () => {
	await app.close();
});

const COURSE = "0b9d8a7e-2c1f-4d6a-9f3e-5a4b3c2d1e0f";
const PERSON = "7f1e2d3c-4b5a-4968-8a7b-6c5d4e3f2a1b";
const CALLER = {
	kind: "api_key" as const,
	apiKey: "portikus_secret",
	ip: "203.0.113.7",
	userAgent: "agent/1",
};

describe("runOperation", () => {
	test("builds the URL from the catalog pattern and sends the caller's key and address", async () => {
		const result = await runOperation(app, NO_DB, CALLER, "courses.members", {
			path: { courseId: COURSE },
		});
		expect(result).toEqual({ ok: true, status: 200, body: '{"ok":true}' });
		expect(seen).toEqual([
			{
				method: "GET",
				url: `/courses/${COURSE}/members`,
				ip: "203.0.113.7",
				authorization: "Bearer portikus_secret",
				userAgent: "agent/1",
				contentType: undefined,
				body: undefined,
			},
		]);
	});

	test.each(["search", "c1", "a b?x=1#y%2F", "1", COURSE.toUpperCase().slice(1)])(
		"a path value of %j is not a uuid, so it is refused without a request",
		async (courseId) => {
			const result = await runOperation(app, NO_DB, CALLER, "courses.members", {
				path: { courseId },
			});
			expect(result).toMatchObject({
				ok: false,
				error: {
					code: "VALIDATION_FAILED",
					message: expect.stringContaining("courseId"),
				},
			});
			expect(seen).toEqual([]);
		},
	);

	test("a fixed route beside /admin/users/:id is never reached with a word for an id", async () => {
		const result = await runOperation(app, NO_DB, CALLER, "users.disable", {
			path: { id: "search" },
		});
		expect(result).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
		expect(seen).toEqual([]);
	});

	test.each([".", "..", "../../admin/users", "a/b", "/"])(
		"a path value of %j could name another route, so it is refused without a request",
		async (courseId) => {
			const result = await runOperation(app, NO_DB, CALLER, "courses.members", {
				path: { courseId },
			});
			expect(result).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
			expect(seen).toEqual([]);
		},
	);

	test("an id of .. is refused before any request", async () => {
		const result = await runOperation(app, NO_DB, CALLER, "users.disable", {
			path: { id: ".." },
		});
		expect(result).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
		expect(seen).toEqual([]);
	});

	test("a path value the operation does not name is refused without a request", async () => {
		const result = await runOperation(app, NO_DB, CALLER, "courses.members", {
			path: { courseId: COURSE, userId: PERSON },
		});
		expect(result).toMatchObject({
			ok: false,
			error: { code: "VALIDATION_FAILED", message: expect.stringContaining("userId") },
		});
		expect(seen).toEqual([]);
	});

	test("query values, lists included, are encoded into the query string", async () => {
		await runOperation(app, NO_DB, CALLER, "users.list", {
			query: { q: "a b&c", page: 2, active: true, tag: ["x", "y"], skip: null },
		});
		expect(seen[0]?.url).toBe("/admin/users?q=a+b%26c&page=2&active=true&tag=x&tag=y");
	});

	test("a JSON body goes with a change, never with a read", async () => {
		await runOperation(app, NO_DB, CALLER, "users.disable", {
			path: { id: PERSON },
			body: { reason: "x" },
		});
		expect(seen[0]).toMatchObject({
			method: "POST",
			url: `/admin/users/${PERSON}/disable`,
			contentType: "application/json",
			body: { reason: "x" },
		});
		await runOperation(app, NO_DB, CALLER, "users.list", { body: { ignored: true } });
		expect(seen[1]).toMatchObject({ method: "GET", contentType: undefined });
	});

	test("an unknown operation is refused without a request", async () => {
		const result = await runOperation(app, NO_DB, CALLER, "nothing.here", {});
		expect(result).toMatchObject({
			ok: false,
			error: { code: "NOT_AVAILABLE_TO_API_KEYS" },
		});
		expect(seen).toEqual([]);
	});

	test.each([{}, { courseId: "" }, { courseId: { nested: 1 } }])(
		"a missing or unusable path value (%j) is refused without a request",
		async (path) => {
			const result = await runOperation(app, NO_DB, CALLER, "courses.members", {
				path,
			});
			expect(result).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
			expect(seen).toEqual([]);
		},
	);

	test("a nested query value is refused without a request", async () => {
		const result = await runOperation(app, NO_DB, CALLER, "users.list", {
			query: { filter: { a: 1 } },
		});
		expect(result).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
		expect(seen).toEqual([]);
	});
});

describe("runOperation for the assistant", () => {
	const ASSISTANT = {
		kind: "assistant" as const,
		sessionToken: "session-token",
		ip: "203.0.113.9",
		userAgent: "browser/2",
	};

	test("sends the session cookie and same-origin, never a key", async () => {
		const result = await runOperation(app, NO_DB, ASSISTANT, "courses.list", {});
		expect(result).toEqual({ ok: true, status: 200, body: '{"ok":true}' });
		expect(rawHeaders[0]).toMatchObject({
			cookie: "portikus_session=session-token",
			"sec-fetch-site": "same-origin",
			[ASSISTANT_MARK.header]: ASSISTANT_MARK.value,
			"user-agent": "browser/2",
		});
		expect(rawHeaders[0]).not.toHaveProperty("authorization");
		expect(seen[0]?.ip).toBe("203.0.113.9");
	});

	test("an unknown operation is refused without a request", async () => {
		const result = await runOperation(app, NO_DB, ASSISTANT, "nothing.here", {});
		expect(result).toMatchObject({
			ok: false,
			error: { code: "NOT_AVAILABLE_TO_API_KEYS" },
		});
		expect(seen).toEqual([]);
	});
});

const AGENT_TOKEN = "run-assistant-agent-token";

/**
 * The assistant acts as the signed-in person (SPEC.md sections 20.4 and
 * 24.11): the session is looked up on every call, so every refusal the
 * browser would get, it gets, and the route's own audit rows say they came
 * through the assistant.
 */
describe.skipIf(!hasTestDb())("runOperation as a signed-in person", () => {
	let testDb: TestDb;
	let mock: MockOidcProvider;
	let agent: FakeAgent;
	let server: FastifyInstance;
	let world: MatrixWorld;

	beforeAll(async () => {
		testDb = await createTestDb();
		mock = await startMockOidcProvider({ users: MATRIX_MOCK_USERS });
		agent = await startFakeAgent(AGENT_TOKEN);
	});

	afterAll(async () => {
		await testDb.close();
		await mock.close();
		await agent.close();
	});

	beforeEach(async () => {
		await testDb.truncate();
		server = buildTestServer(testDb.db, mock.issuer, { AGENT_PORT: agent.port });
		await server.ready();
		world = await buildMatrixWorld(server, testDb.db, AGENT_TOKEN);
	});

	afterEach(async () => {
		await server.close();
	});

	function tokenOf(jar: CookieJar): string {
		const token = jar.get(server.sessionCookieName);
		if (!token) throw new Error("the jar holds no session");
		return token;
	}

	function asPerson(jar: CookieJar) {
		return {
			kind: "assistant" as const,
			sessionToken: tokenOf(jar),
			ip: "198.51.100.4",
		};
	}

	async function userId(subject: string): Promise<string> {
		const row = await testDb.db
			.selectFrom("users")
			.select("id")
			.where("oidc_subject", "=", subject)
			.executeTakeFirstOrThrow();
		return row.id;
	}

	/** What the browser gets for the same request. */
	async function overHttp(
		jar: CookieJar,
		method: "GET" | "PUT",
		url: string,
		payload?: unknown,
	) {
		const response = await server.inject({
			method,
			url,
			headers: csrfHeaders(jar, PUBLIC_URL),
			...(payload === undefined ? {} : { payload: payload as object }),
		});
		return { status: response.statusCode, body: response.json() };
	}

	async function viaRunner(jar: CookieJar, name: string, input = {}) {
		const result = await runOperation(server, testDb.db, asPerson(jar), name, input);
		if (!result.ok) throw new Error(`the runner refused ${name}`);
		return { status: result.status, body: JSON.parse(result.body) as unknown };
	}

	async function auditRows(action: string) {
		return testDb.db
			.selectFrom("audit_events")
			.select(["actor", "target", "result", "metadata", "via", "api_key_id"])
			.where("action", "=", action)
			.orderBy("id")
			.execute();
	}

	test("a route's own audit row says via assistant, and the call writes one assistant.used row", async () => {
		const result = await viaRunner(world.instructor, "courses.set_profile", {
			path: { courseId: world.courseId },
			body: { profile: "traditional" },
		});
		expect(result.status).toBe(200);
		const instructorId = await userId("ivy");
		expect(await auditRows("course.profile_changed")).toMatchObject([
			{ actor: `user:${instructorId}`, via: "assistant", api_key_id: null },
		]);
		expect(await auditRows("assistant.used")).toEqual([
			{
				actor: `user:${instructorId}`,
				target: instructorId,
				result: "ok",
				metadata: {
					operation: "courses.set_profile",
					status: 200,
					code: null,
					ip: "198.51.100.4",
					userAgent: null,
				},
				via: "assistant",
				api_key_id: null,
			},
		]);
	});

	test("the same change made in the browser says via session", async () => {
		const answer = await overHttp(
			world.instructor,
			"PUT",
			`/courses/${world.courseId}/profile`,
			{
				profile: "traditional",
			},
		);
		expect(answer.status).toBe(200);
		expect(await auditRows("course.profile_changed")).toMatchObject([
			{ via: "session" },
		]);
		expect(await auditRows("assistant.used")).toEqual([]);
	});

	test("an instructor gets the instructor's refusals, recorded with their code", async () => {
		const own = await viaRunner(world.instructor, "courses.list");
		expect(own.status).toBe(200);
		const adminOnly = await viaRunner(world.instructor, "courses.list_all");
		expect(adminOnly).toEqual(
			await overHttp(world.instructor, "GET", "/admin/courses"),
		);
		expect(adminOnly.status).toBe(403);
		expect(await auditRows("assistant.used")).toMatchObject([
			{
				result: "ok",
				metadata: { operation: "courses.list", status: 200, code: null },
			},
			{
				result: "denied",
				metadata: { operation: "courses.list_all", status: 403, code: "FORBIDDEN" },
			},
		]);
	});

	test("a student is refused staff operations exactly as in the browser", async () => {
		const course = world.courseId;
		for (const [name, method, url, input] of [
			["courses.list_all", "GET", "/admin/courses", {}],
			[
				"courses.members",
				"GET",
				`/courses/${course}/members`,
				{ path: { courseId: course } },
			],
			[
				"courses.set_profile",
				"PUT",
				`/courses/${course}/profile`,
				{ path: { courseId: course }, body: { profile: "traditional" } },
			],
		] as const) {
			const payload = "body" in input ? input.body : undefined;
			const result = await viaRunner(world.a.jar, name, input);
			expect(result, name).toEqual(await overHttp(world.a.jar, method, url, payload));
			expect([403, 404], name).toContain(result.status);
		}
		expect(await auditRows("course.profile_changed")).toEqual([]);
	});

	test("a signed-out session is refused as the browser is, and writes no row", async () => {
		const jar = world.instructor;
		const token = tokenOf(jar);
		await server.inject({
			method: "POST",
			url: "/auth/logout",
			headers: csrfHeaders(jar, PUBLIC_URL),
		});
		const result = await runOperation(
			server,
			testDb.db,
			{ kind: "assistant", sessionToken: token, ip: "198.51.100.4" },
			"courses.list",
			{},
		);
		const browser = await server.inject({
			method: "GET",
			url: "/courses",
			cookies: { [server.sessionCookieName]: token },
		});
		expect(result).toEqual({ ok: true, status: 401, body: browser.body });
		expect(await auditRows("assistant.used")).toEqual([]);
	});

	test("a disabled account is refused as the browser is", async () => {
		const result = await viaRunner(world.disabled, "courses.list");
		expect(result).toEqual(await overHttp(world.disabled, "GET", "/courses"));
		expect(result.status).toBe(401);
	});

	test("a demoted administrator is refused at once", async () => {
		expect((await viaRunner(world.admin, "courses.list_all")).status).toBe(200);
		await testDb.db
			.updateTable("users")
			.set({ role: "student" })
			.where("oidc_subject", "=", "carol")
			.execute();
		expect((await viaRunner(world.admin, "courses.list_all")).status).toBe(403);
	});

	test("the password-change gate holds the assistant too", async () => {
		await testDb.db
			.updateTable("users")
			.set({ must_change_password: true })
			.where("oidc_subject", "=", "ivy")
			.execute();
		const result = await viaRunner(world.instructor, "courses.list");
		expect(result).toEqual(await overHttp(world.instructor, "GET", "/courses"));
		expect(result.body).toMatchObject({ code: "PASSWORD_CHANGE_REQUIRED" });
	});

	test("an outside request cannot claim to be the assistant", async () => {
		await server.inject({
			method: "PUT",
			url: `/courses/${world.courseId}/profile`,
			headers: {
				...csrfHeaders(world.instructor, PUBLIC_URL),
				"x-portikus-assistant-0000000000000000": "0".repeat(64),
			},
			payload: { profile: "traditional" },
		});
		expect(await auditRows("course.profile_changed")).toMatchObject([
			{ via: "session" },
		]);
		expect(await auditRows("assistant.used")).toEqual([]);
	});
});
