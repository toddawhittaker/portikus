/**
 * The Sign-in tab's routes (SPEC.md 5.1, 5.2, 20.1, 24.8; ADR 0059): a sign-in change is a trial request for the root site job,
 * Keep waits for a passing test sign-in, and a test sign-in never creates a
 * user, a session or a role.
 */
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	CookieJar,
	csrfHeaders,
	loginAs,
	MOCK_USERS,
	type MockOidcProvider,
	startMockOidcProvider,
} from "@portikus/auth/testing";
import { AdminSignin, type SiteView } from "@portikus/contracts";
import { createTestDb, hasTestDb, type TestDb } from "@portikus/db/testing";
import type { FastifyInstance } from "fastify";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "vitest";
import { buildTestServer, PUBLIC_URL } from "../testing/test-support.js";

const skip = !hasTestDb();
let testDb: TestDb;
let mock: MockOidcProvider;
let dir = "";
let jobsDir = "";
let viewFile = "";

const TRIAL = "11111111-2222-4333-8444-555555555555";
const SECRET = "client-secret-0123456789";

const VIEW: SiteView = {
	version: 1,
	apt: true,
	host: "portikus.example.edu",
	port: 443,
	previewSuffix: "preview.portikus.example.edu",
	previewSuffixSetByHand: false,
	provider: "oidc",
	entraTenantId: null,
	googleDomains: [],
	oidcIssuer: "https://login.example.edu",
	clientId: "portikus",
	clientSecretSet: true,
	groupsClaim: "groups",
	groups: { student: "students", instructor: "teachers", admin: "admins" },
	certificateSource: "internal",
};

const OIDC = {
	provider: "oidc",
	oidcIssuer: "https://login.example.edu",
	clientId: "portikus",
	clientSecret: SECRET,
	groupsClaim: "groups",
	groups: { student: "students", instructor: "teachers", admin: "admins" },
};

beforeAll(async () => {
	if (skip) return;
	testDb = await createTestDb();
	mock = await startMockOidcProvider({ redirectUris: [`${PUBLIC_URL}/auth/callback`] });
});

afterAll(async () => {
	if (skip) return;
	await testDb.close();
	await mock.close();
});

beforeEach(async () => {
	if (skip) return;
	await testDb.truncate();
	dir = await mkdtemp(join(tmpdir(), "admin-signin-"));
	jobsDir = join(dir, "site-jobs");
	viewFile = join(dir, "site-view.json");
	await mkdir(join(jobsDir, "status"), { recursive: true });
});

afterEach(async () => {
	if (dir) await rm(dir, { recursive: true, force: true });
});

function server(overrides: Record<string, unknown> = {}): FastifyInstance {
	return buildTestServer(testDb.db, mock.issuer, {
		SITE_JOBS_DIR: jobsDir,
		SITE_VIEW_FILE: viewFile,
		...overrides,
	});
}

async function signIn(app: FastifyInstance, who: string) {
	const jar = new CookieJar();
	await loginAs(app, who, jar);
	const send = (method: "GET" | "POST", url: string, payload?: unknown) =>
		app.inject({
			method,
			url,
			headers: csrfHeaders(jar, PUBLIC_URL),
			...(payload === undefined ? {} : { payload: payload as object }),
		});
	return { jar, send };
}

async function putView(view: Partial<SiteView> = {}): Promise<void> {
	await writeFile(viewFile, JSON.stringify({ ...VIEW, ...view }));
}

async function openTrial(id = TRIAL): Promise<void> {
	await writeFile(
		join(jobsDir, "status", `${id}.json`),
		JSON.stringify({
			id,
			kind: "signin",
			state: "trial",
			code: null,
			startedAt: new Date().toISOString(),
			finishedAt: null,
			trialEndsAt: new Date(Date.now() + 30 * 60_000).toISOString(),
		}),
	);
}

async function requests(): Promise<Record<string, unknown>[]> {
	const names = (await readdir(jobsDir)).filter((n) => n.startsWith("request-"));
	return Promise.all(
		names.map(async (n) => JSON.parse(await readFile(join(jobsDir, n), "utf8"))),
	);
}

async function clearRequests(): Promise<void> {
	for (const n of await readdir(jobsDir)) {
		if (n.startsWith("request-")) await rm(join(jobsDir, n));
	}
}

/**
 * Run a test sign-in as the administrator in `jar`, picking `who` on the
 * mock provider. Returns the start and the callback's answers.
 */
async function testSignIn(app: FastifyInstance, jar: CookieJar, who: string) {
	const start = await app.inject({
		method: "POST",
		url: "/admin/signin/test",
		headers: csrfHeaders(jar, PUBLIC_URL),
	});
	const testJar = new CookieJar();
	testJar.capture(jar.cookieHeader().split("; "));
	testJar.capture(start);
	const authorize = new URL(String(start.headers.location));
	authorize.searchParams.set("user", who);
	const chosen = await fetch(authorize, { redirect: "manual" });
	const callback = new URL(String(chosen.headers.get("location")));
	const done = await app.inject({
		method: "GET",
		url: `${callback.pathname}${callback.search}`,
		headers: { cookie: testJar.cookieHeader() },
	});
	return { start, authorize, done };
}

async function counts() {
	const n = async (table: "users" | "sessions") =>
		Number(
			(
				await testDb.db
					.selectFrom(table)
					.select((eb) => eb.fn.countAll().as("n"))
					.executeTakeFirstOrThrow()
			).n,
		);
	return { users: await n("users"), sessions: await n("sessions") };
}

async function testRows() {
	return testDb.db
		.selectFrom("audit_events")
		.selectAll()
		.where("action", "=", "settings.signin_tested")
		.orderBy("id")
		.execute();
}

describe.skipIf(skip)("access", () => {
	test("the routes are 404 with no site job directory", async () => {
		const app = server({ SITE_JOBS_DIR: undefined });
		const { send } = await signIn(app, "carol");
		expect((await send("GET", "/admin/signin")).statusCode).toBe(404);
		expect((await send("POST", "/admin/signin", OIDC)).statusCode).toBe(404);
		expect((await send("POST", "/admin/signin/test")).statusCode).toBe(404);
		await app.close();
	});

	test("a student can neither read, change nor test the provider", async () => {
		await putView();
		await openTrial();
		const app = server();
		const { send } = await signIn(app, "alice");
		expect((await send("GET", "/admin/signin")).statusCode).toBe(403);
		expect((await send("POST", "/admin/signin", OIDC)).statusCode).toBe(403);
		const keep = await send("POST", "/admin/signin/keep", { trialId: TRIAL });
		expect(keep.statusCode).toBe(403);
		const back = await send("POST", "/admin/signin/rollback", { trialId: TRIAL });
		expect(back.statusCode).toBe(403);
		const start = await send("POST", "/admin/signin/test");
		expect(start.statusCode).toBe(403);
		expect(start.headers.location).toBeUndefined();
		expect(await requests()).toEqual([]);
		await app.close();
	});
});

describe.skipIf(skip)("GET /admin/signin", () => {
	test("shows the provider with only a flag for the secret, the trial and no test yet", async () => {
		await putView();
		await openTrial();
		const app = server();
		const { send } = await signIn(app, "carol");
		const res = await send("GET", "/admin/signin");
		expect(res.statusCode).toBe(200);
		expect(res.headers["cache-control"]).toBe("no-store");
		const body = AdminSignin.parse(res.json());
		expect(body.current).toMatchObject({ provider: "oidc", clientSecretSet: true });
		expect(body.job).toMatchObject({ id: TRIAL, state: "trial" });
		expect(body.lastTest).toBeNull();
		await app.close();
	});

	test("off an apt install, or before setup wrote the view, there are no settings", async () => {
		const app = server();
		const { send } = await signIn(app, "carol");
		expect(AdminSignin.parse((await send("GET", "/admin/signin")).json()).current).toBe(
			null,
		);
		await putView({ apt: false });
		expect(AdminSignin.parse((await send("GET", "/admin/signin")).json()).current).toBe(
			null,
		);
		await app.close();
	});

	test("LDAP shows read-only with its host", async () => {
		await putView({
			provider: "ldap",
			clientId: null,
			ldapHost: "ldap.example.edu:636",
		});
		const app = server();
		const { send } = await signIn(app, "carol");
		const body = AdminSignin.parse((await send("GET", "/admin/signin")).json());
		expect(body.current).toMatchObject({
			provider: "ldap",
			ldapHost: "ldap.example.edu:636",
		});
		await app.close();
	});
});

describe.skipIf(skip)("POST /admin/signin", () => {
	test("writes an owner-only signin request and an audit row without the secret", async () => {
		await putView({ clientSecretSet: false });
		const app = server();
		const { send } = await signIn(app, "carol");
		const res = await send("POST", "/admin/signin", OIDC);
		expect(res.statusCode).toBe(202);
		expect(res.json()).toMatchObject({ state: "queued" });
		const [request] = await requests();
		expect(request).toMatchObject({ kind: "signin", ...OIDC, version: 1 });
		const rows = await testDb.db
			.selectFrom("audit_events")
			.selectAll()
			.where("action", "=", "site.job_requested")
			.execute();
		expect(rows).toHaveLength(1);
		expect(JSON.stringify(rows[0])).not.toContain(SECRET);
		await app.close();
	});

	test("LDAP is refused: it is set only with dpkg-reconfigure", async () => {
		await putView();
		const app = server();
		const { send } = await signIn(app, "carol");
		const res = await send("POST", "/admin/signin", {
			provider: "ldap",
			clientSecret: null,
		});
		expect(res.statusCode).toBe(400);
		expect(await requests()).toEqual([]);
		await app.close();
	});

	test("a refusal names the fields, never the values", async () => {
		await putView();
		const app = server();
		const { send } = await signIn(app, "carol");
		const res = await send("POST", "/admin/signin", {
			...OIDC,
			clientSecret: "{{ 7*7 }}-0123456789abcdef",
		});
		expect(res.statusCode).toBe(400);
		expect(res.json().message).toContain("clientSecret");
		expect(res.body).not.toContain("7*7");
		await app.close();
	});

	test("off an apt install it is refused", async () => {
		const app = server();
		const { send } = await signIn(app, "carol");
		expect((await send("POST", "/admin/signin", OIDC)).json().code).toBe(
			"SITE_UNAVAILABLE",
		);
		await putView({ apt: false });
		expect((await send("POST", "/admin/signin", OIDC)).json().code).toBe(
			"SITE_UNAVAILABLE",
		);
		expect(await requests()).toEqual([]);
		await app.close();
	});

	test("a waiting job or an open trial blocks a new change", async () => {
		await putView();
		const app = server();
		const { send } = await signIn(app, "carol");
		expect((await send("POST", "/admin/signin", OIDC)).statusCode).toBe(202);
		const busy = await send("POST", "/admin/signin", OIDC);
		expect(busy.statusCode).toBe(409);
		expect(busy.json().code).toBe("SITE_JOB_BUSY");
		await clearRequests();
		await openTrial();
		const open = await send("POST", "/admin/signin", OIDC);
		expect(open.statusCode).toBe(409);
		expect(open.json().code).toBe("SITE_JOB_BUSY");
		expect(open.json().message).toContain("trial");
		await app.close();
	});
});

describe.skipIf(skip)("missing_secret, checked before the root job sees it", () => {
	const cases: Array<[string, Partial<SiteView>, Record<string, unknown>, boolean]> = [
		["same provider and client, secret kept", {}, {}, false],
		["no secret stored", { clientSecretSet: false }, {}, true],
		["a new client ID", {}, { clientId: "portikus-2" }, true],
		["a new issuer", {}, { oidcIssuer: "https://other.example.edu" }, true],
		[
			"groups only",
			{},
			{ groups: { student: "s", instructor: "i", admin: "a" } },
			false,
		],
		[
			"a new provider",
			{},
			{
				provider: "entra",
				entraTenantId: "12345678-90ab-cdef-1234-567890abcdef",
				oidcIssuer: undefined,
			},
			true,
		],
		[
			"a new tenant",
			{ provider: "entra", entraTenantId: "12345678-90ab-cdef-1234-567890abcdef" },
			{
				provider: "entra",
				entraTenantId: "abcdef12-90ab-cdef-1234-567890abcdef",
				oidcIssuer: undefined,
			},
			true,
		],
		["from LDAP", { provider: "ldap", clientSecretSet: false }, {}, true],
	];
	test.each(cases)("%s", async (_name, view, change, refused) => {
		await putView(view);
		const app = server();
		const { send } = await signIn(app, "carol");
		const res = await send("POST", "/admin/signin", {
			...OIDC,
			...change,
			clientSecret: null,
		});
		if (refused) {
			expect(res.statusCode).toBe(400);
			expect(res.json().code).toBe("SIGNIN_SECRET_REQUIRED");
			expect(await requests()).toEqual([]);
		} else {
			expect(res.statusCode).toBe(202);
		}
		await app.close();
	});

	test("Dex passwords only needs no secret", async () => {
		await putView({ clientSecretSet: false });
		const app = server();
		const { send } = await signIn(app, "carol");
		const res = await send("POST", "/admin/signin", {
			provider: "dex",
			clientSecret: null,
		});
		expect(res.statusCode).toBe(202);
		await app.close();
	});
});

describe.skipIf(skip)("validation agrees with the root job's shared values", () => {
	const fixture = JSON.parse(
		// The values the root job's own tests use (ADR 0059).
		readFileSync(
			fileURLToPath(
				new URL(
					"../../../../packaging/site/tests/fixtures/values.json",
					import.meta.url,
				),
			),
			"utf8",
		),
	) as { fields: Record<string, { good: unknown[]; bad: unknown[] }> };

	const ENTRA = {
		provider: "entra",
		entraTenantId: "12345678-90ab-cdef-1234-567890abcdef",
		clientId: "portikus",
		clientSecret: SECRET,
	};
	const GOOGLE = {
		provider: "google",
		googleDomains: ["example.edu"],
		clientId: "portikus",
		clientSecret: SECRET,
	};
	// Each signin field the fixture covers, as a body holding the value.
	const BODIES: Record<string, (value: unknown) => Record<string, unknown>> = {
		identifier: (v) => ({ ...OIDC, clientId: v }),
		groupName: (v) => ({ ...OIDC, groups: { ...OIDC.groups, instructor: v } }),
		tenantId: (v) => ({ ...ENTRA, entraTenantId: v }),
		oidcIssuer: (v) => ({ ...OIDC, oidcIssuer: v }),
		groupsClaim: (v) => ({ ...OIDC, groupsClaim: v }),
		clientSecret: (v) => ({ ...OIDC, clientSecret: v }),
		siteHost: (v) => ({ ...GOOGLE, googleDomains: [v] }),
	};

	test("every good value is accepted and every bad one refused", async () => {
		await putView();
		const app = server();
		const { send } = await signIn(app, "carol");
		for (const [field, body] of Object.entries(BODIES)) {
			const values = fixture.fields[field];
			expect(values, field).toBeDefined();
			for (const value of values?.good ?? []) {
				const res = await send("POST", "/admin/signin", body(value));
				expect(res.statusCode, `${field} good ${JSON.stringify(value)}`).toBe(202);
				await clearRequests();
			}
			for (const value of values?.bad ?? []) {
				const res = await send("POST", "/admin/signin", body(value));
				expect(res.statusCode, `${field} bad ${JSON.stringify(value)}`).toBe(400);
			}
		}
		await app.close();
	});
});

describe.skipIf(skip)("the test sign-in", () => {
	test("starts at the provider's own connector, asking to sign in again", async () => {
		await putView();
		const app = server();
		const { jar } = await signIn(app, "carol");
		const start = await app.inject({
			method: "POST",
			url: "/admin/signin/test",
			headers: csrfHeaders(jar, PUBLIC_URL),
		});
		expect(start.statusCode).toBe(303);
		const to = new URL(String(start.headers.location));
		expect(to.searchParams.get("connector_id")).toBe("oidc");
		expect(to.searchParams.get("prompt")).toBe("login");
		await app.close();
	});

	test("a cross-site post cannot start one", async () => {
		await putView();
		const app = server();
		const { jar } = await signIn(app, "carol");
		const start = await app.inject({
			method: "POST",
			url: "/admin/signin/test",
			headers: { cookie: jar.cookieHeader(), "sec-fetch-site": "cross-site" },
		});
		expect(start.statusCode).toBe(403);
		expect(start.headers.location).toBeUndefined();
		expect(start.headers["set-cookie"]).toBeUndefined();
		await app.close();
	});

	test("a login cookie with a wrong test marker is refused, never taken as a sign-in", async () => {
		await putView();
		const app = server();
		const { jar } = await signIn(app, "carol");
		const start = await app.inject({
			method: "POST",
			url: "/admin/signin/test",
			headers: csrfHeaders(jar, PUBLIC_URL),
		});
		// Re-sign the login cookie with the marker broken, as only the server could.
		const [pair] = String(start.headers["set-cookie"]).split(";");
		const [name, raw] = (pair ?? "").split(/=(.*)/s) as [string, string];
		const unsigned = app.unsignCookie(decodeURIComponent(raw));
		const state = JSON.parse(String(unsigned.value));
		const broken = { ...state, signinTest: { adminId: "not-a-uuid" } };
		const cookie = `${name}=${encodeURIComponent(app.signCookie(JSON.stringify(broken)))}`;
		const authorize = new URL(String(start.headers.location));
		authorize.searchParams.set("user", "olga");
		const chosen = await fetch(authorize, { redirect: "manual" });
		const callback = new URL(String(chosen.headers.get("location")));
		const before = await counts();
		const done = await app.inject({
			method: "GET",
			url: `${callback.pathname}${callback.search}`,
			headers: { cookie: `${jar.cookieHeader()}; ${cookie}` },
		});
		expect(done.statusCode).toBe(400);
		expect(String(done.headers["set-cookie"] ?? "")).not.toContain("portikus_session=");
		expect(await counts()).toEqual(before);
		expect(await testRows()).toEqual([]);
		await app.close();
	});

	test("passes, and writes no user, session or role, and no email", async () => {
		await putView();
		await openTrial();
		const app = server();
		const { jar } = await signIn(app, "carol");
		const admin = await testDb.db
			.selectFrom("users")
			.select(["id", "role", "granted_role", "provider_role"])
			.where("oidc_subject", "=", "carol")
			.executeTakeFirstOrThrow();
		const before = await counts();
		const auditBefore = await testDb.db
			.selectFrom("audit_events")
			.select("action")
			.execute();

		const { done } = await testSignIn(app, jar, "olga");
		expect(done.statusCode).toBe(302);
		expect(done.headers.location).toBe("/admin/signin?test=passed");
		// No session cookie for anyone.
		expect(String(done.headers["set-cookie"] ?? "")).not.toContain("portikus_session=");

		expect(await counts()).toEqual(before);
		const olga = await testDb.db
			.selectFrom("users")
			.select("id")
			.where("oidc_subject", "=", MOCK_USERS.olga?.sub ?? "")
			.executeTakeFirst();
		expect(olga).toBeUndefined();
		const adminAfter = await testDb.db
			.selectFrom("users")
			.select(["id", "role", "granted_role", "provider_role"])
			.where("id", "=", admin.id)
			.executeTakeFirstOrThrow();
		expect(adminAfter).toEqual(admin);
		// The test adds one audit row, and no sign-in or role change.
		const auditAfter = await testDb.db
			.selectFrom("audit_events")
			.select("action")
			.execute();
		expect(auditAfter.map((r) => r.action).sort()).toEqual(
			[...auditBefore.map((r) => r.action), "settings.signin_tested"].sort(),
		);

		const [row] = await testRows();
		expect(row).toMatchObject({
			actor: `user:${admin.id}`,
			target: TRIAL,
			result: "ok",
		});
		expect(row?.metadata).toMatchObject({
			result: "passed",
			role: "student",
			connector: "oidc",
			trialId: TRIAL,
		});
		expect(JSON.stringify(row)).not.toContain("@example.edu");
		expect(JSON.stringify(row)).not.toContain("Olga");

		const { send } = await signIn(app, "carol");
		const view = AdminSignin.parse((await send("GET", "/admin/signin")).json());
		expect(view.lastTest).toMatchObject({
			result: "passed",
			role: "student",
			connector: "oidc",
			trialId: TRIAL,
		});
		await app.close();
	});

	test("fails for a person not from the provider's connector", async () => {
		await putView();
		const app = server();
		const { jar } = await signIn(app, "carol");
		const before = await counts();
		// alice's subject is not Dex's, so no connector: not the provider's sign-in.
		const { done } = await testSignIn(app, jar, "alice");
		expect(done.headers.location).toBe("/admin/signin?test=failed");
		expect(await counts()).toEqual(before);
		const [row] = await testRows();
		expect(row?.result).toBe("failed");
		expect(row?.metadata).toMatchObject({
			result: "failed",
			role: "student",
			trialId: null,
		});
		await app.close();
	});

	test("fails when the groups map to no role", async () => {
		const subject = MOCK_USERS.olga?.sub ?? "";
		const users = {
			...MOCK_USERS,
			olga: {
				...MOCK_USERS.olga,
				sub: subject,
				groups: [],
			} as (typeof MOCK_USERS)[string],
		};
		const other = await startMockOidcProvider({
			users,
			redirectUris: [`${PUBLIC_URL}/auth/callback`],
		});
		await putView();
		const app = buildTestServer(testDb.db, other.issuer, {
			SITE_JOBS_DIR: jobsDir,
			SITE_VIEW_FILE: viewFile,
		});
		const { jar } = await signIn(app, "carol");
		const { done } = await testSignIn(app, jar, "olga");
		expect(done.headers.location).toBe("/admin/signin?test=failed");
		const [row] = await testRows();
		expect(row?.metadata).toMatchObject({
			result: "failed",
			role: null,
			connector: "oidc",
		});
		await app.close();
		await other.close();
	});

	test("a test cookie without the administrator's session signs no one in and records nothing", async () => {
		await putView();
		const app = server();
		const { jar } = await signIn(app, "carol");
		const start = await app.inject({
			method: "POST",
			url: "/admin/signin/test",
			headers: csrfHeaders(jar, PUBLIC_URL),
		});
		// Only the login cookie, as if the session had ended.
		const bare = new CookieJar();
		bare.capture(start);
		const authorize = new URL(String(start.headers.location));
		authorize.searchParams.set("user", "olga");
		const chosen = await fetch(authorize, { redirect: "manual" });
		const callback = new URL(String(chosen.headers.get("location")));
		const before = await counts();
		const done = await app.inject({
			method: "GET",
			url: `${callback.pathname}${callback.search}`,
			headers: { cookie: bare.cookieHeader() },
		});
		expect(done.statusCode).toBe(302);
		expect(done.headers.location).toBe("/admin/signin");
		expect(String(done.headers["set-cookie"] ?? "")).not.toContain("portikus_session=");
		expect(await counts()).toEqual(before);
		expect(await testRows()).toEqual([]);
		await app.close();
	});
});

describe.skipIf(skip)("keep and roll back", () => {
	test("Keep waits for a passing test of the open trial", async () => {
		await putView();
		await openTrial();
		const app = server();
		const { jar, send } = await signIn(app, "carol");
		const early = await send("POST", "/admin/signin/keep", { trialId: TRIAL });
		expect(early.statusCode).toBe(409);
		expect(early.json().code).toBe("SIGNIN_TEST_REQUIRED");

		await testSignIn(app, jar, "alice");
		const failed = await send("POST", "/admin/signin/keep", { trialId: TRIAL });
		expect(failed.json().code).toBe("SIGNIN_TEST_REQUIRED");

		await testSignIn(app, jar, "olga");
		const kept = await send("POST", "/admin/signin/keep", { trialId: TRIAL });
		expect(kept.statusCode).toBe(202);
		expect(await requests()).toEqual([
			expect.objectContaining({ kind: "keep", trialId: TRIAL }),
		]);
		await app.close();
	});

	test("a pass from before this trial does not count", async () => {
		await putView();
		const app = server();
		const { jar, send } = await signIn(app, "carol");
		await testSignIn(app, jar, "olga");
		await openTrial();
		const res = await send("POST", "/admin/signin/keep", { trialId: TRIAL });
		expect(res.json().code).toBe("SIGNIN_TEST_REQUIRED");
		await app.close();
	});

	test("Dex passwords only can be kept at once", async () => {
		await putView({
			provider: "dex",
			clientId: null,
			oidcIssuer: null,
			clientSecretSet: false,
		});
		await openTrial();
		const app = server();
		const { send } = await signIn(app, "carol");
		const res = await send("POST", "/admin/signin/keep", { trialId: TRIAL });
		expect(res.statusCode).toBe(202);
		await app.close();
	});

	test("roll back asks the job to put the old settings back", async () => {
		await putView();
		await openTrial();
		const app = server();
		const { send } = await signIn(app, "carol");
		const res = await send("POST", "/admin/signin/rollback", { trialId: TRIAL });
		expect(res.statusCode).toBe(202);
		expect(await requests()).toEqual([
			expect.objectContaining({ kind: "rollback", trialId: TRIAL }),
		]);
		await app.close();
	});

	test("a trial that is not open, or a waiting job, refuses both", async () => {
		await putView({ provider: "dex", clientId: null, clientSecretSet: false });
		const app = server();
		const { send } = await signIn(app, "carol");
		for (const url of ["/admin/signin/keep", "/admin/signin/rollback"]) {
			const res = await send("POST", url, { trialId: TRIAL });
			expect(res.json().code).toBe("SITE_NO_OPEN_TRIAL");
		}
		expect((await send("POST", "/admin/signin/keep", {})).statusCode).toBe(400);
		await openTrial();
		expect(
			(await send("POST", "/admin/signin/rollback", { trialId: TRIAL })).statusCode,
		).toBe(202);
		const busy = await send("POST", "/admin/signin/keep", { trialId: TRIAL });
		expect(busy.json().code).toBe("SITE_JOB_BUSY");
		await app.close();
	});
});
