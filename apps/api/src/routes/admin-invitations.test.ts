import { dexLocalSubject } from "@portikus/auth";
import {
	CookieJar,
	csrfHeaders,
	loginAs,
	type MockOidcProvider,
	type MockUser,
	startMockOidcProvider,
} from "@portikus/auth/testing";
import { NOT_INVITED_PATH } from "@portikus/contracts";
import { createTestDb, hasTestDb, type TestDb } from "@portikus/db/testing";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { claimInvitation } from "../sessions/invitations.js";
import { buildTestServer, PUBLIC_URL } from "../testing/test-support.js";

/** Only an administrator's invitation creates an SSO account (SPEC.md section 24.13). */

const skip = !hasTestDb();
let testDb: TestDb;
let mock: MockOidcProvider;
let app: FastifyInstance;
let admin: CookieJar;

/** A Dex subject from an upstream connector, as Dex encodes it (ADR 0023). */
function dexSubject(userId: string, connId: string): string {
	const field = (tag: number, text: string) => {
		const body = Buffer.from(text, "utf8");
		return Buffer.concat([Buffer.from([tag, body.length]), body]);
	};
	return Buffer.concat([field(0x0a, userId), field(0x12, connId)]).toString(
		"base64url",
	);
}

const NEWCOMERS: Record<string, MockUser> = {
	nina: {
		sub: "nina-sub",
		email: "Nina@Example.edu",
		name: "Nina Newcomer",
		groups: ["portikus-students"],
	},
	// Entra: Dex forces email_verified, so the email proves nothing; the UPN does.
	ezra: {
		sub: dexSubject("ezra-oid", "entra"),
		email: "someone.else@example.edu",
		name: "Ezra Entra",
		groups: ["portikus-students"],
		claims: { preferred_username: "Ezra@Tenant.example" },
		// Userinfo wins over the ID token, as Dex serves both.
		userinfoClaims: { preferred_username: "Ezra@Tenant.example" },
	},
	uri: {
		sub: "uri-sub",
		email: "uri@example.edu",
		name: "Uri Unverified",
		groups: ["portikus-students"],
		claims: { email_verified: false },
	},
	lou: {
		sub: dexLocalSubject("lou-local"),
		email: "lou@example.edu",
		name: "Lou Local",
		groups: ["portikus-students"],
	},
};

beforeAll(async () => {
	if (skip) return;
	testDb = await createTestDb();
	mock = await startMockOidcProvider({
		redirectUris: [`${PUBLIC_URL}/auth/callback`],
	});
	Object.assign(mock.users, NEWCOMERS);
});

afterAll(async () => {
	if (skip) return;
	await testDb.close();
	await mock.close();
});

beforeEach(async () => {
	if (skip) return;
	await testDb.truncate();
	app = buildTestServer(testDb.db, mock.issuer);
	await app.ready();
	admin = new CookieJar();
	await loginAs(app, "carol", admin);
	return async () => {
		await app.close();
	};
});

function invite(body: Record<string, unknown>, jar = admin) {
	return app.inject({
		method: "POST",
		url: "/admin/invitations",
		headers: csrfHeaders(jar, PUBLIC_URL),
		payload: body,
	});
}

async function signIn(key: string) {
	const jar = new CookieJar();
	const result = await loginAs(app, key, jar);
	const me = await app.inject({
		method: "GET",
		url: "/auth/me",
		headers: { cookie: jar.cookieHeader() },
	});
	return { ...result, me };
}

function usersWithSubject(subject: string) {
	return testDb.db
		.selectFrom("users")
		.select(["id", "role", "granted_role"])
		.where("oidc_subject", "=", subject)
		.execute();
}

test.skipIf(skip)("an invited person signs in with the invited role", async () => {
	const created = await invite({
		email: "nina@example.edu",
		name: "Nina",
		role: "instructor",
	});
	expect(created.statusCode).toBe(201);
	const id = created.json().id;

	const result = await signIn("nina");
	expect(result.location).toBe("/");
	expect(result.me.json().role).toBe("instructor");

	const [user] = await usersWithSubject("nina-sub");
	expect(user?.granted_role).toBe("instructor");
	const invitation = await testDb.db
		.selectFrom("account_invitations")
		.select(["claimed_by", "claimed_at"])
		.where("id", "=", id)
		.executeTakeFirstOrThrow();
	expect(invitation.claimed_by).toBe(user?.id);
	expect(invitation.claimed_at).not.toBeNull();
	const claimed = await testDb.db
		.selectFrom("audit_events")
		.select("metadata")
		.where("action", "=", "auth.invitation_claimed")
		.where("target", "=", user?.id ?? "")
		.execute();
	expect(claimed.map((row) => row.metadata)).toEqual([
		{ invitationId: id, role: "instructor" },
	]);

	// Claimed: gone from the waiting list, and a second sign-in still works.
	const list = await app.inject({
		method: "GET",
		url: "/admin/invitations",
		headers: { cookie: admin.cookieHeader() },
	});
	expect(list.json().invitations.map((i: { id: string }) => i.id)).not.toContain(id);
	expect((await signIn("nina")).me.statusCode).toBe(200);
});

test.skipIf(skip)(
	"someone uninvited is refused, audited and never created",
	async () => {
		const result = await signIn("nina");
		expect(result.status).toBe(302);
		expect(result.location).toBe(NOT_INVITED_PATH);
		expect(result.me.statusCode).toBe(401);
		expect(await usersWithSubject("nina-sub")).toHaveLength(0);
		const denied = await testDb.db
			.selectFrom("audit_events")
			.select(["actor", "result", "metadata"])
			.where("action", "=", "auth.login")
			.where("target", "=", "nina-sub")
			.execute();
		expect(denied).toHaveLength(1);
		expect(denied[0]?.actor).toBe("subject:nina-sub");
		expect(denied[0]?.result).toBe("denied");
		expect(denied[0]?.metadata).toMatchObject({ reason: "not_invited" });
	},
);

test.skipIf(skip)("a revoked invitation admits nobody", async () => {
	const id = (
		await invite({ email: "nina@example.edu", name: "Nina", role: "student" })
	).json().id;
	const revoked = await app.inject({
		method: "POST",
		url: `/admin/invitations/${id}/revoke`,
		headers: csrfHeaders(admin, PUBLIC_URL),
	});
	expect(revoked.statusCode).toBe(200);
	const again = await app.inject({
		method: "POST",
		url: `/admin/invitations/${id}/revoke`,
		headers: csrfHeaders(admin, PUBLIC_URL),
	});
	expect(again.statusCode).toBe(404);
	expect((await signIn("nina")).location).toBe(NOT_INVITED_PATH);
	const actions = await testDb.db
		.selectFrom("audit_events")
		.select("action")
		.where("action", "like", "admin.invitation_%")
		.orderBy("id")
		.execute();
	expect(actions.map((a) => a.action)).toEqual([
		"admin.invitation_created",
		"admin.invitation_revoked",
	]);
});

test.skipIf(skip)("an unverified email matches no invitation", async () => {
	await invite({ email: "uri@example.edu", name: "Uri", role: "student" });
	expect((await signIn("uri")).location).toBe(NOT_INVITED_PATH);
});

test.skipIf(skip)("an Entra sign-in matches the UPN, never the email", async () => {
	// The email claim names the invited address, but Entra's email is unverified.
	await invite({
		email: "someone.else@example.edu",
		name: "Not Ezra",
		role: "student",
	});
	expect((await signIn("ezra")).location).toBe(NOT_INVITED_PATH);

	await invite({
		email: "ezra@example.edu",
		username: "ezra@tenant.example",
		name: "Ezra",
		role: "student",
	});
	const result = await signIn("ezra");
	expect(result.location).toBe("/");
	expect(result.me.json().role).toBe("student");
});

test.skipIf(skip)(
	"an Entra invitation without a username matches its email as the UPN",
	async () => {
		await invite({ email: "ezra@tenant.example", name: "Ezra", role: "student" });
		expect((await signIn("ezra")).location).toBe("/");
	},
);

test.skipIf(skip)("a Dex local password needs no invitation", async () => {
	const result = await signIn("lou");
	expect(result.location).toBe("/");
});

test.skipIf(skip)("an existing account needs no invitation", async () => {
	await testDb.db
		.insertInto("users")
		.values({
			oidc_issuer: mock.issuer,
			oidc_subject: "nina-sub",
			email: "nina@example.edu",
			display_name: "Nina",
			role: "student",
			provider_role: "student",
		})
		.execute();
	expect((await signIn("nina")).location).toBe("/");
});

test.skipIf(skip)("two sign-ins cannot both claim one invitation", async () => {
	await invite({ email: "nina@example.edu", name: "Nina", role: "student" });
	const identity = (subject: string) => ({
		issuer: mock.issuer,
		subject,
		email: "nina@example.edu",
		displayName: "Nina",
		preferredUsername: null,
	});
	const results = await Promise.all(
		["first", "second", "third"].map((subject) =>
			claimInvitation(testDb.db, {
				identity: identity(subject),
				providerRole: "student",
				emailVerified: true,
			}),
		),
	);
	expect(results.filter((r) => r !== null)).toHaveLength(1);
	const users = await testDb.db
		.selectFrom("users")
		.select("id")
		.where("email", "=", "nina@example.edu")
		.execute();
	expect(users).toHaveLength(1);
});

test.skipIf(skip)("one waiting invitation per email", async () => {
	expect(
		(await invite({ email: "nina@example.edu", name: "Nina", role: "student" }))
			.statusCode,
	).toBe(201);
	const twice = await invite({
		email: "NINA@example.edu",
		name: "Nina",
		role: "student",
	});
	expect(twice.statusCode).toBe(409);
	expect(twice.json().code).toBe("INVITATION_EXISTS");
});

test.skipIf(skip)("the list shows waiting invitations only", async () => {
	await invite({ email: "nina@example.edu", name: "Nina", role: "administrator" });
	const list = await app.inject({
		method: "GET",
		url: "/admin/invitations",
		headers: { cookie: admin.cookieHeader() },
	});
	expect(list.statusCode).toBe(200);
	const nina = list
		.json()
		.invitations.find((i: { email: string }) => i.email === "nina@example.edu");
	expect(nina).toMatchObject({
		displayName: "Nina",
		role: "administrator",
		username: null,
	});
});

test.skipIf(skip)("a student cannot invite", async () => {
	const alice = new CookieJar();
	await loginAs(app, "alice", alice);
	const res = await invite(
		{ email: "x@example.edu", name: "X", role: "student" },
		alice,
	);
	expect(res.statusCode).toBe(403);
});

test.skipIf(skip)("a bad invitation is a validation error", async () => {
	const res = await invite({ email: "not an email", name: "", role: "student" });
	expect(res.statusCode).toBe(400);
});
