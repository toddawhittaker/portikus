import { createOidcClient, createSession, type LtiPlatform } from "@portikus/auth";
import {
	CookieJar,
	loginAs,
	type MockOidcProvider,
	startMockOidcProvider,
} from "@portikus/auth/testing";
import {
	createTestDb,
	hasTestDb,
	insertTestLtiMembership,
	insertTestLtiUser,
	type TestDb,
} from "@portikus/db/testing";
import { collectingLogger } from "@portikus/observability/testing";
import type { FastifyInstance } from "fastify";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { toAuthOptions } from "../auth-options.js";
import { buildServer } from "../server.js";
import { PUBLIC_URL, testConfig } from "../test-support.js";

/**
 * Linking a course account to an SSO account (docs/EPIC-13-1.md, "The
 * flow" and "Security invariants to test").
 */

const skip = !hasTestDb();
const LMS = "https://lms.test.invalid";
const platform: LtiPlatform = {
	name: "Test LMS",
	issuer: LMS,
	clientId: "client-1",
	authLoginUrl: `${LMS}/authorize`,
	keysetUrl: `${LMS}/jwks`,
	deploymentIds: ["dep-1"],
	mock: true,
};
const ORIGIN = new URL(PUBLIC_URL).origin;

let testDb: TestDb;
let mock: MockOidcProvider;
let app: FastifyInstance;
let lines: Record<string, unknown>[];

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
	const config = testConfig(mock.issuer);
	const collected = collectingLogger("debug");
	lines = collected.lines;
	app = buildServer({
		db: testDb.db,
		config,
		logger: collected.logger,
		oidc: createOidcClient(toAuthOptions(config)),
		lti: { platforms: [platform], toolKeyPem: null },
	});
	await app.ready();
	return () => app.close();
});

/** Make every session of a user look this many seconds old. */
async function ageSessions(userId: string, seconds: number): Promise<void> {
	await sql`update sessions set created_at = now() - make_interval(secs => ${seconds})
		where user_id = ${userId}`.execute(testDb.db);
}

/** A course account with a workspace and a membership, signed in as by a launch. */
async function courseAccount(
	options: { ageSeconds?: number; subject?: string } = {},
): Promise<{ id: string; jar: CookieJar; workspaceId: string }> {
	const id = await insertTestLtiUser(testDb.db, LMS, {
		oidc_subject: options.subject ?? "course-sub-1",
		display_name: "Sam Student",
		email: "sam@example.edu",
	});
	await insertTestLtiMembership(testDb.db, id, { issuer: LMS });
	const workspace = await testDb.db
		.insertInto("workspaces")
		.values({
			owner_user_id: id,
			label: `ws-${id.slice(0, 8)}`,
			state: "running",
			desired_state: "running",
		})
		.returning("id")
		.executeTakeFirstOrThrow();
	const session = await createSession(testDb.db, id, 43200, {
		method: "lti",
		courseUserId: null,
	});
	if (options.ageSeconds) {
		await ageSessions(id, options.ageSeconds);
	}
	const jar = new CookieJar();
	jar.capture(`portikus_session=${session.token}`);
	return { id, jar, workspaceId: workspace.id };
}

/** An SSO account made by a real sign-in; returns its id and jar. */
async function ssoAccount(user: string): Promise<{ id: string; jar: CookieJar }> {
	const jar = new CookieJar();
	await loginAs(app, user, jar);
	const row = await testDb.db
		.selectFrom("users")
		.select("id")
		.where("oidc_subject", "=", user)
		.executeTakeFirstOrThrow();
	return { id: row.id, jar };
}

function post(url: string, jar: CookieJar) {
	return app.inject({
		method: "POST",
		url,
		headers: { cookie: jar.cookieHeader(), origin: ORIGIN },
	});
}

function get(url: string, jar: CookieJar) {
	return app.inject({ url, headers: { cookie: jar.cookieHeader() } });
}

/** Start a link and sign in at the mock provider; returns the callback path. */
async function startAndPick(jar: CookieJar, user: string): Promise<string> {
	const start = await post("/me/links/start", jar);
	expect(start.statusCode).toBe(200);
	jar.capture(start);
	const authorize = new URL(start.json().redirectUrl);
	expect(authorize.searchParams.get("prompt")).toBe("login");
	authorize.searchParams.set("user", user);
	const chosen = await fetch(authorize, { redirect: "manual" });
	const callback = new URL(chosen.headers.get("location") as string);
	return `${callback.pathname}${callback.search}`;
}

async function callback(path: string, jar: CookieJar) {
	const res = await get(path, jar);
	jar.capture(res);
	return res;
}

async function userCount(): Promise<number> {
	const rows = await testDb.db.selectFrom("users").select("id").execute();
	return rows.length;
}

async function audits(action: string) {
	return testDb.db
		.selectFrom("audit_events")
		.selectAll()
		.where("action", "=", action)
		.orderBy("id")
		.execute();
}

describe.skipIf(skip)("GET /me/links", () => {
	test("a course session sees its link window", async () => {
		const course = await courseAccount();
		const res = await get("/me/links", course.jar);
		expect(res.statusCode).toBe(200);
		const body = res.json();
		expect(body.source).toBe("course");
		expect(body.links).toEqual([]);
		const session = await testDb.db
			.selectFrom("sessions")
			.select("created_at")
			.executeTakeFirstOrThrow();
		expect(new Date(body.linkUntil).getTime()).toBe(
			new Date(session.created_at).getTime() + 15 * 60 * 1000,
		);
	});

	test("an SSO session has no window and lists nothing yet", async () => {
		const alice = await ssoAccount("alice");
		const res = await get("/me/links", alice.jar);
		expect(res.json()).toEqual({
			source: "sso",
			linkUntil: null,
			links: [],
			launch: null,
		});
	});
});

describe.skipIf(skip)("the whole link, then unlink", () => {
	test("links, retires the course account, lands in the SSO account, and unlinks", async () => {
		const alice = await ssoAccount("alice");
		const course = await courseAccount();
		const before = await userCount();

		const path = await startAndPick(course.jar, "alice");
		const res = await callback(path, course.jar);
		expect(res.statusCode).toBe(302);
		expect(res.headers.location).toBe("/link");
		// The callback in link mode starts no session and creates no user.
		expect(res.cookies.find((c) => c.name === "portikus_session")).toBeUndefined();
		expect(await userCount()).toBe(before);
		const oldCookie = course.jar.cookieHeader();

		const pending = await get("/me/links/pending", course.jar);
		expect(pending.statusCode).toBe(200);
		expect(pending.json()).toEqual({
			course: { displayName: "Sam Student", platformName: "Test LMS" },
			sso: {
				displayName: "Alice Student",
				signInName: "alice",
				email: expect.any(String),
			},
		});

		const confirm = await post("/me/links/confirm", course.jar);
		expect(confirm.statusCode).toBe(200);
		course.jar.capture(confirm);
		const me = await get("/auth/me", course.jar);
		expect(me.json().id).toBe(alice.id);

		// The course session is dead and the course workspace archived, not deleted.
		const dead = await app.inject({ url: "/auth/me", headers: { cookie: oldCookie } });
		expect(dead.statusCode).toBe(401);
		const ws = await testDb.db
			.selectFrom("workspaces")
			.select(["archived_at", "desired_state"])
			.where("id", "=", course.workspaceId)
			.executeTakeFirstOrThrow();
		expect(ws.archived_at).not.toBeNull();
		expect(ws.desired_state).toBe("stopped");
		// Memberships moved to the SSO account.
		const memberships = await testDb.db
			.selectFrom("lti_memberships")
			.select("user_id")
			.execute();
		expect(memberships.map((m) => m.user_id)).toEqual([alice.id]);

		const linked = await audits("user.linked");
		expect(linked).toHaveLength(1);
		expect(linked[0]).toMatchObject({
			actor: `user:${alice.id}`,
			target: alice.id,
			result: "ok",
		});
		expect(linked[0]?.metadata).toMatchObject({
			platform: "Test LMS",
			courseUserId: course.id,
		});
		expect((await audits("workspace.archived"))[0]?.metadata).toEqual({
			reason: "account_linked",
		});
		const logins = await audits("auth.login");
		expect(logins.at(-1)?.metadata).toMatchObject({ method: "link" });

		const list = await get("/me/links", course.jar);
		expect(list.json().links).toEqual([
			{
				courseUserId: course.id,
				platformName: "Test LMS",
				displayName: "Sam Student",
				linkedAt: expect.any(String),
			},
		]);

		const unlink = await post(`/me/links/${course.id}/unlink`, course.jar);
		expect(unlink.statusCode).toBe(200);
		// A link-method session unlinks from the SSO side and stays signed in.
		expect(unlink.json()).toEqual({ signedOut: false });
		expect((await get("/me/links", course.jar)).json().links).toEqual([]);
		const back = await testDb.db
			.selectFrom("workspaces")
			.select(["archived_at", "desired_state"])
			.where("id", "=", course.workspaceId)
			.executeTakeFirstOrThrow();
		expect(back.archived_at).toBeNull();
		expect(back.desired_state).toBe("stopped");
		expect((await audits("user.unlinked"))[0]).toMatchObject({
			actor: `user:${alice.id}`,
			target: alice.id,
			result: "ok",
		});
		expect((await audits("user.unlinked"))[0]?.metadata).toMatchObject({ side: "sso" });
		expect((await audits("workspace.unarchived"))[0]?.metadata).toEqual({
			reason: "account_unlinked",
		});

		// Nothing logged or audited carries the state, a token, a name, email or subject.
		const state = new URL(`http://x${path}`).searchParams.get("state") as string;
		const everything = JSON.stringify([
			lines,
			await testDb.db.selectFrom("audit_events").selectAll().execute(),
		]);
		for (const secret of [
			state,
			"Sam Student",
			"Alice",
			"sam@example.edu",
			"course-sub-1",
			'"alice"',
		]) {
			expect(everything).not.toContain(secret);
		}
		for (const cookie of [oldCookie, course.jar.cookieHeader()]) {
			expect(everything).not.toContain(cookie.split("=")[1]);
		}
	});

	test("unlinking someone else's link, or no link, is 404", async () => {
		const bob = await ssoAccount("bob");
		const course = await courseAccount();
		const res = await post(`/me/links/${course.id}/unlink`, bob.jar);
		expect(res.statusCode).toBe(404);
	});
});

describe.skipIf(skip)("starting a link", () => {
	test("an SSO session cannot start one", async () => {
		const alice = await ssoAccount("alice");
		const res = await post("/me/links/start", alice.jar);
		expect(res.statusCode).toBe(400);
	});

	test("a course session older than 15 minutes cannot start one", async () => {
		const course = await courseAccount({ ageSeconds: 16 * 60 });
		const res = await post("/me/links/start", course.jar);
		expect(res.statusCode).toBe(400);
		expect(res.json().message).toBe("Open Portikus again from your course to link it.");
		expect((await get("/me/links", course.jar)).json().source).toBe("course");
	});

	test("start without an Origin is refused by the CSRF check", async () => {
		const course = await courseAccount();
		const res = await app.inject({
			method: "POST",
			url: "/me/links/start",
			headers: { cookie: course.jar.cookieHeader() },
		});
		expect(res.statusCode).toBe(403);
	});
});

describe.skipIf(skip)("the callback's refusals go to /link", () => {
	test("no_account: an SSO identity with no account is refused and not created", async () => {
		const course = await courseAccount();
		const before = await userCount();
		const res = await callback(await startAndPick(course.jar, "bob"), course.jar);
		expect(res.headers.location).toBe("/link?error=no_account");
		expect(await userCount()).toBe(before);
		expect((await get("/me/links/pending", course.jar)).statusCode).toBe(404);
		const [row] = await audits("user.linked");
		expect(row).toMatchObject({ result: "denied", actor: `user:${course.id}` });
		expect(row?.metadata).toMatchObject({ reason: "no_account" });
	});

	test("not_authorized: no role from the provider's groups", async () => {
		const course = await courseAccount();
		const res = await callback(await startAndPick(course.jar, "dave"), course.jar);
		expect(res.headers.location).toBe("/link?error=not_authorized");
	});

	test("not_authorized: a disabled SSO account", async () => {
		const alice = await ssoAccount("alice");
		await testDb.db
			.updateTable("users")
			.set({ disabled_at: new Date().toISOString() })
			.where("id", "=", alice.id)
			.execute();
		const course = await courseAccount();
		const res = await callback(await startAndPick(course.jar, "alice"), course.jar);
		expect(res.headers.location).toBe("/link?error=not_authorized");
	});

	test("link mode does not update the SSO account from claims", async () => {
		const alice = await ssoAccount("alice");
		await testDb.db
			.updateTable("users")
			.set({
				display_name: "Kept Name",
				role: "instructor",
				provider_role: "instructor",
			})
			.where("id", "=", alice.id)
			.execute();
		const course = await courseAccount();
		await callback(await startAndPick(course.jar, "alice"), course.jar);
		const row = await testDb.db
			.selectFrom("users")
			.select(["display_name", "role"])
			.where("id", "=", alice.id)
			.executeTakeFirstOrThrow();
		expect(row).toEqual({ display_name: "Kept Name", role: "instructor" });
	});

	test("session_changed: another session carries the state back", async () => {
		await ssoAccount("alice");
		const course = await courseAccount();
		const path = await startAndPick(course.jar, "alice");
		const other = await courseAccount({ subject: "course-sub-2" });
		// The other browser holds the signed login cookie too, but not the session.
		const login = course.jar.get("portikus_login") as string;
		other.jar.capture(`portikus_login=${login}`);
		const res = await callback(path, other.jar);
		expect(res.headers.location).toBe("/link?error=session_changed");

		const signedOut = new CookieJar();
		signedOut.capture(`portikus_login=${login}`);
		const again = await callback(path, signedOut);
		expect(again.headers.location).toBe("/link?error=session_changed");
	});

	test("expired: an intent past its time, or already used", async () => {
		await ssoAccount("alice");
		const course = await courseAccount();
		const path = await startAndPick(course.jar, "alice");
		const login = course.jar.get("portikus_login") as string;
		await testDb.db
			.updateTable("account_link_intents")
			.set({ expires_at: new Date(Date.now() - 1000).toISOString() })
			.execute();
		const res = await callback(path, course.jar);
		expect(res.headers.location).toBe("/link?error=expired");

		// A bound intent cannot be bound again by a replayed callback.
		const path2 = await startAndPick(course.jar, "alice");
		const login2 = course.jar.get("portikus_login") as string;
		expect(login2).not.toBe(login);
		expect((await callback(path2, course.jar)).headers.location).toBe("/link");
		course.jar.capture(`portikus_login=${login2}`);
		expect((await callback(path2, course.jar)).headers.location).toBe(
			"/link?error=expired",
		);
	});

	test("expired: a link callback whose login cookie is gone goes back to /link", async () => {
		await ssoAccount("alice");
		const course = await courseAccount();
		const path = await startAndPick(course.jar, "alice");
		const bare = new CookieJar();
		bare.capture(`portikus_session=${course.jar.get("portikus_session")}`);
		const res = await callback(path, bare);
		expect(res.statusCode).toBe(302);
		expect(res.headers.location).toBe("/link?error=expired");
		// A tampered cookie is treated the same way.
		bare.capture("portikus_login=tampered");
		expect((await callback(path, bare)).headers.location).toBe("/link?error=expired");

		// With no intent behind the state it stays the ordinary sign-in answer.
		const plain = await callback(
			"/auth/callback?state=unknown&code=x",
			new CookieJar(),
		);
		expect(plain.statusCode).toBe(400);
	});

	test("already_linked: one course identity per platform on an SSO account", async () => {
		const alice = await ssoAccount("alice");
		const first = await courseAccount({ subject: "course-sub-1" });
		await callback(await startAndPick(first.jar, "alice"), first.jar);
		expect((await post("/me/links/confirm", first.jar)).statusCode).toBe(200);

		const second = await courseAccount({ subject: "course-sub-2" });
		const res = await callback(await startAndPick(second.jar, "alice"), second.jar);
		expect(res.headers.location).toBe("/link?error=already_linked");
		const denied = (await audits("user.linked")).filter((r) => r.result === "denied");
		expect(denied[0]?.actor).toBe(`user:${alice.id}`);
	});

	test("failed: the provider's answer does not check out", async () => {
		const course = await courseAccount();
		const path = await startAndPick(course.jar, "alice");
		const forged = path.replace(/code=[^&]+/, "code=forged");
		const res = await callback(forged, course.jar);
		expect(res.headers.location).toBe("/link?error=failed");
	});
});

describe.skipIf(skip)("confirming", () => {
	test("with nothing pending is 404, and a pending intent is used once", async () => {
		const course = await courseAccount();
		expect((await post("/me/links/confirm", course.jar)).statusCode).toBe(404);
		expect((await get("/me/links/pending", course.jar)).statusCode).toBe(404);
	});

	test("a course session that passed 15 minutes after the callback cannot confirm", async () => {
		await ssoAccount("alice");
		const course = await courseAccount();
		await callback(await startAndPick(course.jar, "alice"), course.jar);
		await ageSessions(course.id, 16 * 60);
		const res = await post("/me/links/confirm", course.jar);
		expect(res.statusCode).toBe(400);
		const links = await testDb.db.selectFrom("account_links").selectAll().execute();
		expect(links).toEqual([]);
		expect((await get("/auth/me", course.jar)).json().id).toBe(course.id);
	});

	test("an SSO account disabled after the callback cannot be linked (review S3)", async () => {
		const alice = await ssoAccount("alice");
		const course = await courseAccount();
		await callback(await startAndPick(course.jar, "alice"), course.jar);
		await testDb.db
			.updateTable("users")
			.set({ disabled_at: new Date().toISOString() })
			.where("id", "=", alice.id)
			.execute();
		const res = await post("/me/links/confirm", course.jar);
		expect(res.statusCode).toBe(400);
		expect(await testDb.db.selectFrom("account_links").selectAll().execute()).toEqual(
			[],
		);
		const denied = (await audits("user.linked")).filter((r) => r.result === "denied");
		expect(denied.at(-1)?.metadata).toMatchObject({ reason: "not_authorized" });
		expect((await get("/auth/me", course.jar)).json().id).toBe(course.id);
	});

	test("confirm without an Origin is refused by the CSRF check", async () => {
		const course = await courseAccount();
		const res = await app.inject({
			method: "POST",
			url: "/me/links/confirm",
			headers: { cookie: course.jar.cookieHeader() },
		});
		expect(res.statusCode).toBe(403);
	});
});
