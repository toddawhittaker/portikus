import { generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createOidcClient,
	createSession,
	type LtiPlatform,
	ltiStateCookieName,
	PlatformsFileError,
} from "@portikus/auth";
import {
	createTestDb,
	hasTestDb,
	insertTestUser,
	type TestDb,
} from "@portikus/db/testing";
import { collectingLogger } from "@portikus/observability/testing";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { toAuthOptions } from "../auth-options.js";
import { buildServer } from "../server.js";
import { PUBLIC_URL, testConfig } from "../test-support.js";
import { loadLtiDeps, targetPath, toolJwks } from "./lti.js";

/**
 * LTI 1.3 login and launch against a real database and a local keyset
 * (docs/EPIC-13.md, T3; rulings 12 to 22).
 */

const skip = !hasTestDb();
const ISSUER = "https://lms.test.invalid";
const CLIENT_ID = "client-1";
const CLAIM = "https://purl.imsglobal.org/spec/lti/claim/";
const ROLE = "http://purl.imsglobal.org/vocab/lis/v2/membership#";
const LOGIN_HINT = "login-hint-9d2f";

const signing = generateKeyPairSync("rsa", { modulusLength: 2048 });
const stranger = generateKeyPairSync("rsa", { modulusLength: 2048 });
const toolKeyPem = generateKeyPairSync("rsa", { modulusLength: 2048 })
	.privateKey.export({ type: "pkcs8", format: "pem" })
	.toString();

let testDb: TestDb;
let jwksServer: Server;
let platform: LtiPlatform;
let app: FastifyInstance;
let lines: Record<string, unknown>[];

beforeAll(async () => {
	jwksServer = createServer((_request, response) => {
		const jwk = {
			...signing.publicKey.export({ format: "jwk" }),
			kid: "k1",
			alg: "RS256",
		};
		response.setHeader("content-type", "application/json");
		response.end(JSON.stringify({ keys: [jwk] }));
	});
	await new Promise<void>((resolve) => jwksServer.listen(0, "127.0.0.1", resolve));
	const { port } = jwksServer.address() as AddressInfo;
	platform = {
		name: "Test LMS",
		issuer: ISSUER,
		clientId: CLIENT_ID,
		authLoginUrl: `${ISSUER}/authorize`,
		keysetUrl: `http://127.0.0.1:${port}/jwks`,
		deploymentIds: ["dep-1"],
		mock: true,
	};
	if (skip) return;
	testDb = await createTestDb();
});

afterAll(async () => {
	await new Promise((resolve) => jwksServer.close(resolve));
	if (skip) return;
	await testDb.close();
});

function build(lti: boolean): FastifyInstance {
	const config = testConfig("http://127.0.0.1:1/unused");
	const collected = collectingLogger("debug");
	lines = collected.lines;
	return buildServer({
		db: testDb.db,
		config,
		logger: collected.logger,
		oidc: createOidcClient(toAuthOptions(config)),
		...(lti ? { lti: { platforms: [platform], toolKeyPem } } : {}),
	});
}

beforeEach(async () => {
	if (skip) return;
	await testDb.truncate();
	app = build(true);
	await app.ready();
	return () => app.close();
});

function b64(value: unknown): string {
	return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function mint(
	claims: Record<string, unknown>,
	options: { key?: KeyObject; alg?: string } = {},
): string {
	const input = `${b64({ alg: options.alg ?? "RS256", typ: "JWT", kid: "k1" })}.${b64(claims)}`;
	if (options.alg === "none") return `${input}.`;
	const signature = sign(
		"sha256",
		Buffer.from(input),
		options.key ?? signing.privateKey,
	);
	return `${input}.${signature.toString("base64url")}`;
}

interface Person {
	sub: string;
	name?: string;
	roles?: string[];
	context?: { id: string; title: string } | null;
}

function claimsFor(person: Person, nonce: string): Record<string, unknown> {
	const now = Math.floor(Date.now() / 1000);
	const claims: Record<string, unknown> = {
		iss: ISSUER,
		aud: CLIENT_ID,
		sub: person.sub,
		exp: now + 300,
		iat: now,
		nonce,
		name: person.name ?? "Sam Student",
		email: "sam@example.edu",
		[`${CLAIM}deployment_id`]: "dep-1",
		[`${CLAIM}message_type`]: "LtiResourceLinkRequest",
		[`${CLAIM}version`]: "1.3.0",
		[`${CLAIM}target_link_uri`]: `${PUBLIC_URL}/?from=lms`,
		[`${CLAIM}resource_link`]: { id: "rl-1" },
		[`${CLAIM}roles`]: person.roles ?? [`${ROLE}Learner`],
	};
	if (person.context !== null) {
		claims[`${CLAIM}context`] = person.context ?? { id: "ctx-1", title: "CS 101" };
	}
	return claims;
}

const loginQuery = new URLSearchParams({
	iss: ISSUER,
	login_hint: LOGIN_HINT,
	target_link_uri: `${PUBLIC_URL}/`,
	client_id: CLIENT_ID,
}).toString();

async function startLogin(): Promise<{ state: string; nonce: string }> {
	const res = await app.inject({ url: `/lti/login?${loginQuery}` });
	expect(res.statusCode).toBe(302);
	const location = new URL(res.headers.location as string);
	expect(location.origin + location.pathname).toBe(platform.authLoginUrl);
	const state = location.searchParams.get("state") ?? "";
	const nonce = location.searchParams.get("nonce") ?? "";
	const cookie = res.cookies.find((one) => one.name === ltiStateCookieName(state));
	expect(cookie?.value).toBe(state);
	expect(cookie?.path).toBe("/");
	return { state, nonce };
}

/** The Cookie header a browser sends back for this login's state. */
function stateCookie(state: string, value = state): string {
	return `${ltiStateCookieName(state)}=${value}`;
}

/** Every LTI audit row carries the client address and browser too. */
const client = { ip: expect.any(String), userAgent: expect.any(String) };

function postLaunch(
	fields: Record<string, string>,
	headers: Record<string, string> = {},
): Promise<LightMyRequestResponse> {
	return app.inject({
		method: "POST",
		url: "/lti/launch",
		headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
		payload: new URLSearchParams(fields).toString(),
	});
}

/** A whole launch; `edit` may change the claims or the token. */
async function launch(
	person: Person,
	edit: {
		claims?: (claims: Record<string, unknown>) => void;
		sign?: (claims: Record<string, unknown>) => string;
	} = {},
): Promise<{
	res: LightMyRequestResponse;
	token: string;
	state: string;
	nonce: string;
}> {
	const { state, nonce } = await startLogin();
	const claims = claimsFor(person, nonce);
	edit.claims?.(claims);
	const token = edit.sign ? edit.sign(claims) : mint(claims);
	const res = await postLaunch(
		{ id_token: token, state },
		{ cookie: stateCookie(state) },
	);
	return { res, token, state, nonce };
}

function sessionCookie(res: LightMyRequestResponse): string | undefined {
	return res.cookies.find((one) => one.name === "portikus_session")?.value;
}

async function loginAudits() {
	return testDb.db
		.selectFrom("audit_events")
		.selectAll()
		.where("action", "=", "auth.login")
		.orderBy("id")
		.execute();
}

describe.skipIf(skip)("a good launch", () => {
	test("creates the user under lti:<issuer>, a session, a membership and an audit row, and 303s", async () => {
		const { res, token, state, nonce } = await launch({ sub: "student-1" });
		expect(res.statusCode).toBe(303);
		expect(res.headers.location).toBe("/?from=lms");

		const user = await testDb.db
			.selectFrom("users")
			.selectAll()
			.executeTakeFirstOrThrow();
		expect(user).toMatchObject({
			oidc_issuer: `lti:${ISSUER}`,
			oidc_subject: "student-1",
			role: "student",
			display_name: "Sam Student",
			email: "sam@example.edu",
			preferred_username: null,
		});

		const cookie = sessionCookie(res);
		expect(cookie).toBeTruthy();
		const me = await app.inject({
			url: "/auth/me",
			headers: { cookie: `portikus_session=${cookie}` },
		});
		expect(me.statusCode).toBe(200);
		expect(me.json()).toMatchObject({ id: user.id, role: "student" });

		const membership = await testDb.db
			.selectFrom("lti_memberships")
			.innerJoin("lti_contexts", "lti_contexts.id", "lti_memberships.context_id")
			.selectAll()
			.executeTakeFirstOrThrow();
		expect(membership).toMatchObject({
			user_id: user.id,
			role: "student",
			platform_issuer: ISSUER,
			context_id: "ctx-1",
			title: "CS 101",
			platform_name: "Test LMS",
		});

		const audits = await loginAudits();
		expect(audits).toHaveLength(1);
		expect(audits[0]).toMatchObject({ actor: `user:${user.id}`, result: "ok" });
		expect(audits[0]?.metadata).toEqual({
			method: "lti",
			platform: "Test LMS",
			role: "student",
			...client,
		});

		// Nothing secret or personal reaches the log (ruling 9).
		const logged = JSON.stringify(lines);
		for (const secret of [
			token,
			state,
			nonce,
			LOGIN_HINT,
			"Sam Student",
			"sam@example.edu",
		]) {
			expect(logged).not.toContain(secret);
		}
		// The state row is gone.
		const states = await testDb.db.selectFrom("lti_login_states").selectAll().execute();
		expect(states).toEqual([]);
	});

	test("POST /lti/login starts the flow too", async () => {
		const res = await app.inject({
			method: "POST",
			url: "/lti/login",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			payload: loginQuery,
		});
		expect(res.statusCode).toBe(302);
		expect(res.headers.location).toContain(platform.authLoginUrl);
	});

	test("the redirect keeps the target path and query", async () => {
		const { res } = await launch(
			{ sub: "student-1" },
			{
				claims: (claims) => {
					claims[`${CLAIM}target_link_uri`] = `${PUBLIC_URL}/workspace?tab=2`;
				},
			},
		);
		expect(res.headers.location).toBe("/workspace?tab=2");
	});

	test("a target that could leave our origin redirects to /", async () => {
		for (const [path, expected] of [
			["//evil.example/x", "/"],
			["/\\evil.example", "/"],
			// Encoded, these stay one path segment on our origin.
			["/%5Cevil.example", "/%5Cevil.example"],
			["/%2F%2Fevil", "/%2F%2Fevil"],
		] as const) {
			const { res } = await launch(
				{ sub: "student-1" },
				{
					claims: (claims) => {
						claims[`${CLAIM}target_link_uri`] = `${PUBLIC_URL}${path}`;
					},
				},
			);
			expect(res.statusCode, path).toBe(303);
			expect(res.headers.location, path).toBe(expected);
		}
	});

	test("targetPath keeps only a single-slash path on our origin", () => {
		expect(targetPath(`${PUBLIC_URL}/a?b=1`, PUBLIC_URL)).toBe("/a?b=1");
		expect(targetPath(`${PUBLIC_URL}//evil.example/x`, PUBLIC_URL)).toBe("/");
		expect(targetPath(`${PUBLIC_URL}/\\evil.example`, PUBLIC_URL)).toBe("/");
		expect(targetPath("https://evil.example/", PUBLIC_URL)).toBe("/");
	});

	for (const order of ["in order", "in reverse order"]) {
		test(`two logins then two launches ${order} both sign in`, async () => {
			const first = await startLogin();
			const second = await startLogin();
			const both = [first, second];
			if (order === "in reverse order") both.reverse();
			// The browser holds both state cookies and sends both each time.
			const cookie = [stateCookie(first.state), stateCookie(second.state)].join("; ");
			for (const login of both) {
				const res = await postLaunch(
					{
						id_token: mint(claimsFor({ sub: "student-1" }, login.nonce)),
						state: login.state,
					},
					{ cookie },
				);
				expect(res.statusCode).toBe(303);
				expect(sessionCookie(res)).toBeTruthy();
				// Only this launch's cookie is cleared.
				const cleared = res.cookies.filter((one) => one.name.startsWith("__Host-"));
				expect(cleared.map((one) => [one.name, one.path])).toEqual([
					[ltiStateCookieName(login.state), "/"],
				]);
			}
		});
	}

	test("a launch with no context signs in and records no membership", async () => {
		const { res } = await launch({ sub: "student-1", context: null });
		expect(res.statusCode).toBe(303);
		expect(sessionCookie(res)).toBeTruthy();
		const rows = await testDb.db.selectFrom("lti_memberships").selectAll().execute();
		expect(rows).toEqual([]);
	});

	test("a second launch refreshes the role and audits the change", async () => {
		await launch({ sub: "ivy", roles: [`${ROLE}Instructor`] });
		const first = await testDb.db
			.selectFrom("users")
			.select("role")
			.executeTakeFirstOrThrow();
		expect(first.role).toBe("instructor");

		const { res } = await launch({ sub: "ivy", roles: [`${ROLE}Learner`] });
		expect(res.statusCode).toBe(303);
		const user = await testDb.db
			.selectFrom("users")
			.select(["id", "role"])
			.executeTakeFirstOrThrow();
		expect(user.role).toBe("student");
		const membership = await testDb.db
			.selectFrom("lti_memberships")
			.select("role")
			.executeTakeFirstOrThrow();
		expect(membership.role).toBe("student");

		const changes = await testDb.db
			.selectFrom("audit_events")
			.selectAll()
			.where("action", "=", "user.role_changed")
			.execute();
		expect(changes).toHaveLength(1);
		expect(changes[0]).toMatchObject({ target: user.id });
		expect(changes[0]?.metadata).toEqual({
			from: "instructor",
			to: "student",
			source: "lti",
		});
	});

	test("an institution Administrator becomes an instructor, never an administrator", async () => {
		await launch({
			sub: "ada",
			roles: [
				"http://purl.imsglobal.org/vocab/lis/v2/institution/person#Administrator",
			],
		});
		const user = await testDb.db
			.selectFrom("users")
			.select("role")
			.executeTakeFirstOrThrow();
		expect(user.role).toBe("instructor");
	});

	test("a disabled user stays refused, with no session", async () => {
		await launch({ sub: "student-1" });
		await testDb.db
			.updateTable("users")
			.set({ disabled_at: new Date().toISOString() })
			.execute();
		const { res } = await launch({ sub: "student-1" });
		expect(res.statusCode).toBe(403);
		expect(res.headers["content-type"]).toContain("text/html");
		expect(res.body).toContain("not authorized");
		expect(sessionCookie(res)).toBeUndefined();
		const audits = await loginAudits();
		expect(audits[1]).toMatchObject({ result: "denied" });
		expect(audits[1]?.metadata).toEqual({
			method: "lti",
			platform: "Test LMS",
			role: "student",
			...client,
		});
	});

	test("two LTI users with long random subjects get valid, different workspace labels", async () => {
		const labels: string[] = [];
		for (const sub of [
			crypto.randomUUID(),
			`${crypto.randomUUID()}${"x".repeat(200)}`,
		]) {
			const { res } = await launch({ sub });
			const cookie = `portikus_session=${sessionCookie(res)}`;
			const created = await app.inject({
				method: "POST",
				url: "/workspaces",
				headers: { cookie, origin: new URL(PUBLIC_URL).origin },
			});
			expect(created.statusCode).toBe(201);
			labels.push(created.json().label as string);
		}
		for (const label of labels) {
			expect(label).toMatch(/^[a-z][a-z0-9-]{0,62}$/);
		}
		expect(labels[0]).not.toBe(labels[1]);
	});
});

describe.skipIf(skip)("a launch from a linked course identity", () => {
	/** A course account from a first launch, linked to a new SSO account. */
	async function linked(ssoRole: "student" | "instructor" | "administrator") {
		await launch({ sub: "student-1" });
		const course = await testDb.db
			.selectFrom("users")
			.select("id")
			.executeTakeFirstOrThrow();
		const ssoId = await insertTestUser(testDb.db, {
			display_name: "Sso Person",
			email: "sso@example.edu",
			role: ssoRole,
			provider_role: ssoRole === "administrator" ? "student" : ssoRole,
			granted_role: ssoRole === "administrator" ? "administrator" : null,
		});
		await testDb.db
			.insertInto("account_links")
			.values({
				course_user_id: course.id,
				user_id: ssoId,
				platform_issuer: ISSUER,
				archived_at: null,
			})
			.execute();
		return { courseId: course.id, ssoId };
	}

	test("signs into the SSO account, refreshes only the membership, and leaves its role alone", async () => {
		const { courseId, ssoId } = await linked("student");
		const { res } = await launch({
			sub: "student-1",
			name: "Renamed In LMS",
			roles: [`${ROLE}Instructor`],
		});
		expect(res.statusCode).toBe(303);
		const me = await app.inject({
			url: "/auth/me",
			headers: { cookie: `portikus_session=${sessionCookie(res)}` },
		});
		expect(me.json()).toMatchObject({ id: ssoId, role: "student" });

		const sso = await testDb.db
			.selectFrom("users")
			.select(["display_name", "email", "role", "provider_role", "granted_role"])
			.where("id", "=", ssoId)
			.executeTakeFirstOrThrow();
		expect(sso).toEqual({
			display_name: "Sso Person",
			email: "sso@example.edu",
			role: "student",
			provider_role: "student",
			granted_role: null,
		});
		const memberships = await testDb.db
			.selectFrom("lti_memberships")
			.select(["user_id", "role"])
			.execute();
		expect(memberships).toContainEqual({ user_id: ssoId, role: "instructor" });
		const course = await testDb.db
			.selectFrom("users")
			.select("display_name")
			.where("id", "=", courseId)
			.executeTakeFirstOrThrow();
		expect(course.display_name).toBe("Sam Student");

		const audits = await loginAudits();
		expect(audits.at(-1)).toMatchObject({ actor: `user:${ssoId}`, result: "ok" });
		expect(audits.at(-1)?.metadata).toEqual({
			method: "lti",
			platform: "Test LMS",
			role: "instructor",
			linked: true,
			...client,
		});
	});

	test("never starts an administrator session (ruling 21)", async () => {
		const { ssoId } = await linked("administrator");
		const { res } = await launch({ sub: "student-1" });
		expect(res.statusCode).toBe(403);
		expect(res.body).toContain("Administrators sign in with SSO");
		expect(res.body).toContain('href="/auth/login"');
		expect(sessionCookie(res)).toBeUndefined();
		const memberships = await testDb.db
			.selectFrom("lti_memberships")
			.select("user_id")
			.where("user_id", "=", ssoId)
			.execute();
		expect(memberships).toHaveLength(1);
		const audits = await loginAudits();
		expect(audits.at(-1)).toMatchObject({ actor: `user:${ssoId}`, result: "denied" });
		expect(audits.at(-1)?.metadata).toEqual({
			method: "lti",
			platform: "Test LMS",
			reason: "administrator",
			...client,
		});
		const sso = await testDb.db
			.selectFrom("users")
			.select(["role", "granted_role"])
			.where("id", "=", ssoId)
			.executeTakeFirstOrThrow();
		expect(sso).toEqual({ role: "administrator", granted_role: "administrator" });
	});

	test("a disabled SSO account is refused with no session", async () => {
		const { ssoId } = await linked("student");
		await testDb.db
			.updateTable("users")
			.set({ disabled_at: new Date().toISOString() })
			.where("id", "=", ssoId)
			.execute();
		const { res } = await launch({ sub: "student-1" });
		expect(res.statusCode).toBe(403);
		expect(sessionCookie(res)).toBeUndefined();
		const audits = await loginAudits();
		expect(audits.at(-1)).toMatchObject({ actor: `user:${ssoId}`, result: "denied" });
		expect(audits.at(-1)?.metadata).toMatchObject({ reason: "disabled", linked: true });
	});

	/** A linked launch that lands, and its session cookie header. */
	async function linkedSession() {
		const ids = await linked("student");
		const { res } = await launch({ sub: "student-1" });
		expect(res.statusCode).toBe(303);
		return { ...ids, cookie: `portikus_session=${sessionCookie(res)}` };
	}

	const origin = new URL(PUBLIC_URL).origin;

	test("a launch session dies once its account is promoted (review S1)", async () => {
		const { ssoId, cookie } = await linkedSession();
		const session = await testDb.db
			.selectFrom("sessions")
			.select(["method", "course_user_id"])
			.where("user_id", "=", ssoId)
			.executeTakeFirstOrThrow();
		expect(session.method).toBe("lti");
		const admin = await insertTestUser(testDb.db, { role: "administrator" });
		const adminSession = await createSession(testDb.db, admin, 60, {
			method: "oidc",
			courseUserId: null,
		});
		const promote = await app.inject({
			method: "POST",
			url: `/admin/users/${ssoId}/promote`,
			headers: { cookie: `portikus_session=${adminSession.token}`, origin },
		});
		expect(promote.statusCode).toBe(200);
		const refused = await app.inject({ url: "/admin/users", headers: { cookie } });
		expect(refused.statusCode).toBe(401);
		const me = await app.inject({ url: "/auth/me", headers: { cookie } });
		expect(me.statusCode).toBe(401);
	});

	test("GET /me/links names the course identity that launched this session (review S2)", async () => {
		const { courseId, cookie } = await linkedSession();
		const res = await app.inject({ url: "/me/links", headers: { cookie } });
		expect(res.json()).toMatchObject({
			source: "sso",
			launch: { courseUserId: courseId, platformName: "Test LMS" },
		});
	});

	test("the launch session can unlink its own course identity, and then ends (review S2)", async () => {
		const { courseId, ssoId, cookie } = await linkedSession();
		const res = await app.inject({
			method: "POST",
			url: `/me/links/${courseId}/unlink`,
			headers: { cookie, origin },
		});
		expect(res.statusCode).toBe(200);
		expect(res.json()).toEqual({ signedOut: true });
		const cleared = res.cookies.find((one) => one.name === "portikus_session");
		expect(cleared?.value).toBe("");
		const me = await app.inject({ url: "/auth/me", headers: { cookie } });
		expect(me.statusCode).toBe(401);
		const audit = await testDb.db
			.selectFrom("audit_events")
			.selectAll()
			.where("action", "=", "user.unlinked")
			.executeTakeFirstOrThrow();
		expect(audit).toMatchObject({ actor: `user:${courseId}`, target: ssoId });
		expect(audit.metadata).toMatchObject({ side: "course", courseUserId: courseId });
		// The next launch signs into the course account again.
		const again = await launch({ sub: "student-1" });
		const back = await app.inject({
			url: "/auth/me",
			headers: { cookie: `portikus_session=${sessionCookie(again.res)}` },
		});
		expect(back.json().id).toBe(courseId);
	});

	test("an unlink from the SSO side ends every session that came through the identity (review N1)", async () => {
		const { courseId, ssoId, cookie } = await linkedSession();
		const second = await launch({ sub: "student-1" });
		const secondCookie = `portikus_session=${sessionCookie(second.res)}`;
		const sso = await createSession(testDb.db, ssoId, 600, {
			method: "oidc",
			courseUserId: null,
		});
		const ssoCookie = `portikus_session=${sso.token}`;
		const workspace = await testDb.db
			.insertInto("workspaces")
			.values({ owner_user_id: ssoId, label: "ws-n1", state: "running" })
			.returning("id")
			.executeTakeFirstOrThrow();
		const launched = await testDb.db
			.selectFrom("sessions")
			.select("id")
			.where("course_user_id", "=", courseId)
			.execute();
		expect(launched).toHaveLength(2);
		for (const [index, row] of launched.entries()) {
			await testDb.db
				.insertInto("preview_sessions")
				.values({
					token_hash: `preview-${index}`,
					user_id: ssoId,
					session_id: row.id,
					workspace_id: workspace.id,
					port: 3000,
					preview_host: `p${index}.preview.test.invalid`,
				})
				.execute();
		}

		const res = await app.inject({
			method: "POST",
			url: `/me/links/${courseId}/unlink`,
			headers: { cookie: ssoCookie, origin },
		});
		expect(res.json()).toEqual({ signedOut: false });
		for (const one of [cookie, secondCookie]) {
			const me = await app.inject({ url: "/auth/me", headers: { cookie: one } });
			expect(me.statusCode).toBe(401);
		}
		const live = await testDb.db
			.selectFrom("preview_sessions")
			.select("id")
			.where("revoked_at", "is", null)
			.execute();
		expect(live).toEqual([]);
		const still = await app.inject({ url: "/auth/me", headers: { cookie: ssoCookie } });
		expect(still.json().id).toBe(ssoId);
	});

	test("a launch session cannot unlink another course identity (review N2)", async () => {
		const { ssoId, cookie } = await linkedSession();
		const other = await insertTestUser(testDb.db, {
			oidc_issuer: "lti:https://other.test.invalid",
		});
		await testDb.db
			.insertInto("account_links")
			.values({
				course_user_id: other,
				user_id: ssoId,
				platform_issuer: "https://other.test.invalid",
				archived_at: null,
			})
			.execute();
		const res = await app.inject({
			method: "POST",
			url: `/me/links/${other}/unlink`,
			headers: { cookie, origin },
		});
		expect(res.statusCode).toBe(404);
		const links = await testDb.db
			.selectFrom("account_links")
			.select("course_user_id")
			.where("course_user_id", "=", other)
			.execute();
		expect(links).toHaveLength(1);
		const me = await app.inject({ url: "/auth/me", headers: { cookie } });
		expect(me.json().id).toBe(ssoId);
	});
});

describe.skipIf(skip)("refused launches", () => {
	async function expectRefused(
		res: LightMyRequestResponse,
		reason: string,
		status: number,
	): Promise<void> {
		expect(res.statusCode, reason).toBe(status);
		expect(res.headers["content-type"]).toContain("text/html");
		expect(res.body).toContain("Portikus could not open");
		expect(res.body).not.toContain("<script");
		expect(sessionCookie(res)).toBeUndefined();
		const users = await testDb.db.selectFrom("users").select("id").execute();
		expect(users).toEqual([]);
		const audits = await loginAudits();
		if (reason === "framed" || reason === "state_missing") {
			// Anyone can send these; they are logged, not audited.
			expect(audits).toEqual([]);
		} else {
			expect(audits.at(-1)).toMatchObject({ result: "failed", actor: "unknown" });
			const metadata = audits.at(-1)?.metadata as Record<string, unknown>;
			expect(metadata.reason).toBe(reason);
			expect(metadata.method).toBe("lti");
			const keys = ["ip", "method", "reason", "userAgent"];
			if (metadata.platform) keys.push("platform");
			expect(Object.keys(metadata).sort()).toEqual(keys.sort());
		}
		const logged = JSON.stringify(lines);
		expect(logged).toContain(reason);
		expect(logged).not.toContain("Sam Student");
	}

	const now = () => Math.floor(Date.now() / 1000);
	/** Each token is wrong in exactly one way: `set` claims, `drop` one, or `sign` it badly. */
	const tokenDefects: Array<{
		reason: string;
		set?: Record<string, unknown>;
		drop?: string;
		sign?: (claims: Record<string, unknown>) => string;
	}> = [
		{ reason: "bad_signature", sign: (c) => mint(c, { key: stranger.privateKey }) },
		{ reason: "alg_not_allowed", sign: (c) => mint(c, { alg: "none" }) },
		{ reason: "wrong_audience", set: { aud: "someone-else" } },
		{ reason: "expired", set: { exp: now() - 600 } },
		{ reason: "issued_in_future", set: { iat: now() + 600 } },
		{ reason: "nonce_mismatch", set: { nonce: "another-nonce" } },
		{ reason: "unknown_deployment", set: { [`${CLAIM}deployment_id`]: "dep-9" } },
		{
			reason: "wrong_message_type",
			set: { [`${CLAIM}message_type`]: "LtiDeepLinkingRequest" },
		},
		{ reason: "wrong_version", set: { [`${CLAIM}version`]: "1.1.0" } },
		{
			reason: "wrong_target",
			set: { [`${CLAIM}target_link_uri`]: "https://evil.example/" },
		},
		{ reason: "missing_subject", drop: "sub" },
		{ reason: "unknown_issuer", set: { iss: "https://other.invalid" } },
	];

	for (const defect of tokenDefects) {
		test(`a token wrong one way is refused: ${defect.reason}`, async () => {
			const { res } = await launch(
				{ sub: "student-1" },
				{
					claims: (claims) => {
						Object.assign(claims, defect.set);
						if (defect.drop) delete claims[defect.drop];
					},
					...(defect.sign ? { sign: defect.sign } : {}),
				},
			);
			await expectRefused(res, defect.reason, 401);
		});
	}

	test("no state cookie is state_missing, and the row survives", async () => {
		const { state, nonce } = await startLogin();
		const res = await postLaunch({
			id_token: mint(claimsFor({ sub: "student-1" }, nonce)),
			state,
		});
		await expectRefused(res, "state_missing", 400);
		expect(res.body).toContain("open in a new window");
		const rows = await testDb.db.selectFrom("lti_login_states").selectAll().execute();
		expect(rows).toHaveLength(1);
	});

	test("a cookie that does not match the form is state_mismatch", async () => {
		const { state, nonce } = await startLogin();
		const res = await postLaunch(
			{ id_token: mint(claimsFor({ sub: "student-1" }, nonce)), state },
			{ cookie: stateCookie(state, "someone-elses-state") },
		);
		await expectRefused(res, "state_mismatch", 400);
	});

	test("a state with no row is state_missing", async () => {
		const res = await postLaunch(
			{ id_token: "x.y.z", state: "never-issued" },
			{ cookie: stateCookie("never-issued") },
		);
		await expectRefused(res, "state_missing", 400);
	});

	test("a replayed launch is refused: the state is single use", async () => {
		const { res, token, state } = await launch({ sub: "student-1" });
		expect(res.statusCode).toBe(303);
		const again = await postLaunch(
			{ id_token: token, state },
			{ cookie: stateCookie(state) },
		);
		expect(again.statusCode).toBe(400);
		expect(sessionCookie(again)).toBeUndefined();
		const audits = await loginAudits();
		expect(audits.map((row) => row.result)).toEqual(["ok"]);
		expect(JSON.stringify(lines)).toContain("state_missing");
	});

	test("a launch inside a frame is refused and leaves the state for a new tab", async () => {
		const { state, nonce } = await startLogin();
		const fields = { id_token: mint(claimsFor({ sub: "student-1" }, nonce)), state };
		const cookie = stateCookie(state);
		const framed = await postLaunch(fields, { cookie, "sec-fetch-dest": "iframe" });
		await expectRefused(framed, "framed", 400);
		expect(framed.cookies).toEqual([]);
		const rows = await testDb.db.selectFrom("lti_login_states").selectAll().execute();
		expect(rows).toHaveLength(1);
		const top = await postLaunch(fields, { cookie, "sec-fetch-dest": "document" });
		expect(top.statusCode).toBe(303);
	});
});

describe.skipIf(skip)("login initiation", () => {
	test("inside a frame it answers the new-tab page and starts nothing", async () => {
		const res = await app.inject({
			url: `/lti/login?${loginQuery}&lti_message_hint=a%22b`,
			headers: { "sec-fetch-dest": "iframe" },
		});
		expect(res.statusCode).toBe(200);
		expect(res.headers["content-type"]).toContain("text/html");
		const csp = res.headers["content-security-policy"];
		expect(csp).toContain("frame-ancestors *");
		expect(csp).toContain("form-action 'self' https://lms.test.invalid");
		expect(res.body).toContain('target="_blank"');
		expect(res.body).toContain('action="/lti/login"');
		expect(res.body).toContain(`name="login_hint" value="${LOGIN_HINT}"`);
		expect(res.body).toContain('value="a&quot;b"');
		expect(res.body).toContain("Open Portikus in a new tab");
		expect(res.body).not.toContain("<script");
		expect(res.cookies).toEqual([]);
		const rows = await testDb.db.selectFrom("lti_login_states").selectAll().execute();
		expect(rows).toEqual([]);
	});

	test("a frame request (iframe or frame) gets the new-tab page and no cookie", async () => {
		for (const dest of ["iframe", "frame"]) {
			const res = await app.inject({
				url: `/lti/login?${loginQuery}`,
				headers: { "sec-fetch-dest": dest },
			});
			expect(res.statusCode).toBe(200);
			expect(res.body).toContain("Open Portikus in a new tab");
			expect(res.cookies).toEqual([]);
		}
	});

	test("a navigation with Sec-Fetch-Dest document starts the login", async () => {
		const res = await app.inject({
			url: `/lti/login?${loginQuery}`,
			headers: { "sec-fetch-dest": "document" },
		});
		expect(res.statusCode).toBe(302);
		expect(res.cookies).toHaveLength(1);
	});

	test("an image, script, fetch or empty destination is refused before any state", async () => {
		for (const dest of ["image", "script", "empty", "style"]) {
			for (const [method, url] of [
				["GET", `/lti/login?${loginQuery}`],
				["POST", "/lti/login"],
			] as const) {
				const res = await app.inject({
					method,
					url,
					headers: {
						"sec-fetch-dest": dest,
						...(method === "POST"
							? { "content-type": "application/x-www-form-urlencoded" }
							: {}),
					},
					...(method === "POST" ? { payload: loginQuery } : {}),
				});
				expect(res.statusCode).toBe(400);
				expect(res.headers["content-type"]).toContain("text/html");
				expect(res.cookies).toEqual([]);
			}
		}
		const rows = await testDb.db.selectFrom("lti_login_states").selectAll().execute();
		expect(rows).toEqual([]);
	});

	test("a prefetch or prerender is refused before any state", async () => {
		const forms: Record<string, string>[] = [
			{ "sec-purpose": "prefetch" },
			{ "sec-purpose": "prefetch;prerender" },
			{ "sec-purpose": "prefetch;anonymous-client-ip" },
			{ purpose: "prefetch" },
		];
		for (const extra of forms) {
			const res = await app.inject({
				url: `/lti/login?${loginQuery}`,
				headers: { "sec-fetch-dest": "document", ...extra },
			});
			expect(res.statusCode).toBe(400);
			expect(res.headers["content-type"]).toContain("text/html");
			expect(res.cookies).toEqual([]);
		}
		const rows = await testDb.db.selectFrom("lti_login_states").selectAll().execute();
		expect(rows).toEqual([]);
	});

	test("a new login clears the oldest state cookies so at most four remain", async () => {
		const old = ["s1", "s2", "s3", "s4", "s5", "s6"];
		const res = await app.inject({
			url: `/lti/login?${loginQuery}`,
			headers: {
				cookie: [...old.map((s) => stateCookie(s)), "other=1"].join("; "),
			},
		});
		expect(res.statusCode).toBe(302);
		const cleared = res.cookies
			.filter((one) => one.value === "")
			.map((one) => one.name);
		expect(cleared).toEqual([ltiStateCookieName("s1"), ltiStateCookieName("s2")]);
		const set = res.cookies.filter((one) => one.value !== "");
		expect(set).toHaveLength(1);
		expect(set[0]?.name.startsWith("__Host-portikus_lti_state_")).toBe(true);
	});

	test("with four or fewer state cookies a new login clears none", async () => {
		const res = await app.inject({
			url: `/lti/login?${loginQuery}`,
			headers: { cookie: ["a", "b", "c", "d"].map((s) => stateCookie(s)).join("; ") },
		});
		expect(res.statusCode).toBe(302);
		expect(res.cookies).toHaveLength(1);
	});

	test("an unknown issuer or a target off our origin is 400", async () => {
		for (const query of [
			loginQuery.replace(
				encodeURIComponent(ISSUER),
				encodeURIComponent("https://x.invalid"),
			),
			loginQuery.replace(
				encodeURIComponent(`${PUBLIC_URL}/`),
				encodeURIComponent("https://evil.example/"),
			),
		]) {
			const res = await app.inject({ url: `/lti/login?${query}` });
			expect(res.statusCode).toBe(400);
			expect(res.headers["content-type"]).toContain("text/html");
		}
	});

	test("login and launch may be framed by anyone; the keyset by no one", async () => {
		const login = await app.inject({ url: `/lti/login?${loginQuery}` });
		expect(login.headers["content-security-policy"]).toContain("frame-ancestors *");
		const launched = await postLaunch({ state: "x" });
		expect(launched.headers["content-security-policy"]).toContain("frame-ancestors *");
		const keys = await app.inject({ url: "/lti/jwks" });
		expect(keys.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
	});
});

describe.skipIf(skip)("the tool keyset", () => {
	test("serves only the public key, with its thumbprint as kid", async () => {
		const res = await app.inject({ url: "/lti/jwks" });
		expect(res.statusCode).toBe(200);
		const { keys } = res.json() as { keys: Record<string, string>[] };
		expect(keys).toHaveLength(1);
		expect(keys[0]).toMatchObject({ kty: "RSA", alg: "RS256", use: "sig" });
		expect(keys[0]?.d).toBeUndefined();
		expect(keys[0]?.kid).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(res.body).not.toContain(toolKeyPem.slice(40, 80));
	});

	test("with no key file the set is empty", () => {
		expect(toolJwks(null)).toEqual({ keys: [] });
	});
});

describe.skipIf(skip)("with LTI off", () => {
	test("every /lti route answers 404", async () => {
		const off = build(false);
		await off.ready();
		try {
			for (const [method, url] of [
				["GET", `/lti/login?${loginQuery}`],
				["POST", "/lti/login"],
				["POST", "/lti/launch"],
				["GET", "/lti/jwks"],
			] as const) {
				const res = await off.inject({ method, url });
				expect(res.statusCode, `${method} ${url}`).toBe(404);
			}
			// The Course page still answers, with no courses.
			const session = await createSession(
				testDb.db,
				await insertTestUser(testDb.db),
				60,
				{ method: "oidc", courseUserId: null },
			);
			const courses = await off.inject({
				url: "/courses",
				headers: { cookie: `portikus_session=${session.token}` },
			});
			expect(courses.statusCode).toBe(200);
			expect(courses.json()).toEqual([]);
		} finally {
			await off.close();
		}
	});
});

describe("loading the platforms file at start", () => {
	test("unset, or set to a file that is not there, means LTI is off", async () => {
		expect(await loadLtiDeps({})).toBeUndefined();
		const dir = await mkdtemp(join(tmpdir(), "lti-"));
		expect(
			await loadLtiDeps({
				LTI_PLATFORMS_FILE: join(dir, "missing.json"),
				LTI_TOOL_KEY_FILE: join(dir, "missing.pem"),
			}),
		).toBeUndefined();
	});

	test("a good file loads, with the tool key", async () => {
		const dir = await mkdtemp(join(tmpdir(), "lti-"));
		const file = join(dir, "platforms.json");
		const keyFile = join(dir, "tool.pem");
		await writeFile(file, JSON.stringify({ version: 1, platforms: [platform] }));
		await writeFile(keyFile, toolKeyPem);
		const lti = await loadLtiDeps({
			LTI_PLATFORMS_FILE: file,
			LTI_TOOL_KEY_FILE: keyFile,
		});
		expect(lti?.platforms).toEqual([platform]);
		expect(lti?.toolKeyPem).toBe(toolKeyPem);
		const noKey = await loadLtiDeps({ LTI_PLATFORMS_FILE: file });
		expect(noKey?.toolKeyPem).toBeNull();
	});

	test("a file that is there but wrong stops the start", async () => {
		const dir = await mkdtemp(join(tmpdir(), "lti-"));
		const file = join(dir, "platforms.json");
		await writeFile(file, JSON.stringify({ version: 2, platforms: [] }));
		await expect(loadLtiDeps({ LTI_PLATFORMS_FILE: file })).rejects.toBeInstanceOf(
			PlatformsFileError,
		);
	});
});
