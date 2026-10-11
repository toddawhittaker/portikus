import { createOidcClient, createSession, type LtiPlatform } from "@portikus/auth";
import {
	CookieJar,
	csrfHeaders,
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
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { toAuthOptions } from "../auth-options.js";
import { buildServer } from "../server.js";
import { PUBLIC_URL, testConfig } from "../testing/test-support.js";

/**
 * An administrator links and unlinks accounts for someone else (SPEC.md
 * sections 5.2, 20.1, 24.11; ADR 0026).
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

let testDb: TestDb;
let mock: MockOidcProvider;
let app: FastifyInstance;

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
	app = buildServer({
		db: testDb.db,
		config,
		logger: collectingLogger("debug").logger,
		oidc: createOidcClient(toAuthOptions(config)),
		lti: { platforms: [platform], toolKeyPem: null },
	});
	await app.ready();
	return () => app.close();
});

async function signIn(user: string): Promise<{ id: string; jar: CookieJar }> {
	const jar = new CookieJar();
	await loginAs(app, user, jar);
	const row = await testDb.db
		.selectFrom("users")
		.select("id")
		.where("oidc_subject", "=", user)
		.executeTakeFirstOrThrow();
	return { id: row.id, jar };
}

/** A course account with a workspace and a live session. */
async function courseAccount(subject = "course-sub-1") {
	const id = await insertTestLtiUser(testDb.db, LMS, {
		oidc_subject: subject,
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
	await createSession(testDb.db, id, 43200, { method: "lti", courseUserId: null });
	return { id, workspaceId: workspace.id };
}

function call(
	jar: CookieJar,
	method: "GET" | "POST" | "DELETE",
	url: string,
	body?: object,
) {
	return app.inject({
		method,
		url,
		headers: csrfHeaders(jar, PUBLIC_URL),
		...(body ? { payload: body } : {}),
	});
}

async function audits(action: string) {
	return testDb.db
		.selectFrom("audit_events")
		.select(["actor", "target", "result", "metadata"])
		.where("action", "=", action)
		.orderBy("id")
		.execute();
}

async function notices(userId: string) {
	return testDb.db
		.selectFrom("notifications")
		.select(["title", "body", "kept"])
		.where("user_id", "=", userId)
		.execute();
}

describe.skipIf(skip)("Administrator linking", () => {
	test("links, archives, ends sessions, audits with the administrator, and tells the holder", async () => {
		const carol = await signIn("carol");
		const alice = await signIn("alice");
		const course = await courseAccount();

		const res = await call(carol.jar, "POST", `/admin/users/${alice.id}/links`, {
			courseUserId: course.id,
		});
		expect(res.statusCode).toBe(200);
		expect(res.json().links).toMatchObject([
			{ courseUserId: course.id, platformName: "Test LMS", displayName: "Sam Student" },
		]);

		const workspace = await testDb.db
			.selectFrom("workspaces")
			.select(["archived_at", "desired_state"])
			.where("id", "=", course.workspaceId)
			.executeTakeFirstOrThrow();
		expect(workspace.archived_at).not.toBeNull();
		expect(workspace.desired_state).toBe("stopped");
		const sessions = await testDb.db
			.selectFrom("sessions")
			.select("id")
			.where("user_id", "=", course.id)
			.execute();
		expect(sessions).toEqual([]);

		const [linked] = await audits("user.linked");
		expect(linked).toMatchObject({
			actor: `user:${carol.id}`,
			target: alice.id,
			result: "ok",
			metadata: { by: "administrator", courseUserId: course.id, platform: "Test LMS" },
		});
		const [archived] = await audits("workspace.archived");
		expect(archived).toMatchObject({
			actor: `user:${carol.id}`,
			target: course.workspaceId,
		});
		const [notice] = await notices(alice.id);
		expect(notice).toMatchObject({
			title: "An administrator linked a course account to yours",
			kept: true,
		});
		expect(notice?.body).toContain("Sam Student from Test LMS is now linked");
	});

	test("lists the links of an account, and 404s an unknown account", async () => {
		const carol = await signIn("carol");
		const alice = await signIn("alice");
		const course = await courseAccount();
		await call(carol.jar, "POST", `/admin/users/${alice.id}/links`, {
			courseUserId: course.id,
		});
		const list = await call(carol.jar, "GET", `/admin/users/${alice.id}/links`);
		expect(list.json().links).toHaveLength(1);
		const none = await call(
			carol.jar,
			"GET",
			`/admin/users/${crypto.randomUUID()}/links`,
		);
		expect(none.statusCode).toBe(404);
	});

	test("unlinks, unarchives, audits, and tells the holder", async () => {
		const carol = await signIn("carol");
		const alice = await signIn("alice");
		const course = await courseAccount();
		await call(carol.jar, "POST", `/admin/users/${alice.id}/links`, {
			courseUserId: course.id,
		});
		await createSession(testDb.db, alice.id, 3600, {
			method: "lti",
			courseUserId: course.id,
		});

		const res = await call(
			carol.jar,
			"DELETE",
			`/admin/users/${alice.id}/links/${course.id}`,
		);
		expect(res.statusCode).toBe(200);
		expect(res.json().links).toEqual([]);

		const workspace = await testDb.db
			.selectFrom("workspaces")
			.select(["archived_at", "desired_state"])
			.where("id", "=", course.workspaceId)
			.executeTakeFirstOrThrow();
		expect(workspace.archived_at).toBeNull();
		expect(workspace.desired_state).toBe("stopped");
		const launched = await testDb.db
			.selectFrom("sessions")
			.select("id")
			.where("user_id", "=", alice.id)
			.where("course_user_id", "=", course.id)
			.execute();
		expect(launched).toEqual([]);

		const [unlinked] = await audits("user.unlinked");
		expect(unlinked).toMatchObject({
			actor: `user:${carol.id}`,
			target: alice.id,
			metadata: { by: "administrator", courseUserId: course.id },
		});
		const [unarchived] = await audits("workspace.unarchived");
		expect(unarchived?.actor).toBe(`user:${carol.id}`);
		expect((await notices(alice.id)).map((n) => n.title)).toContain(
			"An administrator unlinked a course account from yours",
		);
	});

	test("unlink works after the SSO account became an administrator or was disabled", async () => {
		const carol = await signIn("carol");
		const alice = await signIn("alice");
		const course = await courseAccount();
		await call(carol.jar, "POST", `/admin/users/${alice.id}/links`, {
			courseUserId: course.id,
		});
		await testDb.db
			.updateTable("users")
			.set({ role: "administrator", disabled_at: new Date().toISOString() })
			.where("id", "=", alice.id)
			.execute();
		const res = await call(
			carol.jar,
			"DELETE",
			`/admin/users/${alice.id}/links/${course.id}`,
		);
		expect(res.statusCode).toBe(200);
		expect(res.json().links).toEqual([]);
	});

	test("refuses each bad pairing and audits the denial", async () => {
		const carol = await signIn("carol");
		const alice = await signIn("alice");
		const bob = await signIn("bob");
		const course = await courseAccount();
		const other = await courseAccount("course-sub-2");
		const url = (id: string) => `/admin/users/${id}/links`;

		// A course account as the SSO side.
		const notSso = await call(carol.jar, "POST", url(other.id), {
			courseUserId: course.id,
		});
		expect(notSso.statusCode).toBe(400);
		// An SSO account as the course side.
		const notCourse = await call(carol.jar, "POST", url(alice.id), {
			courseUserId: bob.id,
		});
		expect(notCourse.statusCode).toBe(400);
		// An administrator as the SSO side.
		const admin = await call(carol.jar, "POST", url(carol.id), {
			courseUserId: course.id,
		});
		expect(admin.statusCode).toBe(400);
		// A missing course account.
		const missing = await call(carol.jar, "POST", url(alice.id), {
			courseUserId: crypto.randomUUID(),
		});
		expect(missing.statusCode).toBe(404);
		// A malformed body.
		const bad = await call(carol.jar, "POST", url(alice.id), { courseUserId: "x" });
		expect(bad.statusCode).toBe(400);

		// Already linked, from either side.
		expect(
			(await call(carol.jar, "POST", url(alice.id), { courseUserId: course.id }))
				.statusCode,
		).toBe(200);
		const again = await call(carol.jar, "POST", url(alice.id), {
			courseUserId: other.id,
		});
		expect(again.statusCode).toBe(400);
		const twice = await call(carol.jar, "POST", url(bob.id), {
			courseUserId: course.id,
		});
		expect(twice.statusCode).toBe(400);

		const denied = (await audits("user.linked")).filter((a) => a.result === "denied");
		expect(denied.map((a) => (a.metadata as { reason: string }).reason)).toEqual([
			"not_sso_account",
			"not_course_account",
			"not_authorized",
			"not_found",
			"already_linked",
			"already_linked",
		]);
		expect(denied.every((a) => a.actor === `user:${carol.id}`)).toBe(true);
	});

	test("refuses an SSO account whose role is above the course account's last launch", async () => {
		const carol = await signIn("carol");
		const alice = await signIn("alice");
		await testDb.db
			.updateTable("users")
			.set({ role: "instructor", granted_role: "instructor" })
			.where("id", "=", alice.id)
			.execute();
		const course = await courseAccount();
		const url = `/admin/users/${alice.id}/links`;

		const refused = await call(carol.jar, "POST", url, { courseUserId: course.id });
		expect(refused.statusCode).toBe(400);
		expect(refused.json().message).toContain("higher role");
		const [denied] = (await audits("user.linked")).filter((a) => a.result === "denied");
		expect(denied?.metadata).toMatchObject({ reason: "role_higher" });
		const links = await testDb.db.selectFrom("account_links").selectAll().execute();
		expect(links).toEqual([]);

		// The same person launching as an instructor may be linked.
		await testDb.db
			.updateTable("users")
			.set({ provider_role: "instructor", role: "instructor" })
			.where("id", "=", course.id)
			.execute();
		const linked = await call(carol.jar, "POST", url, { courseUserId: course.id });
		expect(linked.statusCode).toBe(200);
	});

	test("unlinking a link that does not exist is 404", async () => {
		const carol = await signIn("carol");
		const alice = await signIn("alice");
		const course = await courseAccount();
		const res = await call(
			carol.jar,
			"DELETE",
			`/admin/users/${alice.id}/links/${course.id}`,
		);
		expect(res.statusCode).toBe(404);
	});

	test("a student gets 403 on every route", async () => {
		const alice = await signIn("alice");
		const course = await courseAccount();
		const base = `/admin/users/${alice.id}/links`;
		expect((await call(alice.jar, "GET", base)).statusCode).toBe(403);
		expect(
			(await call(alice.jar, "POST", base, { courseUserId: course.id })).statusCode,
		).toBe(403);
		expect((await call(alice.jar, "DELETE", `${base}/${course.id}`)).statusCode).toBe(
			403,
		);
	});
});
