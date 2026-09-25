import {
	createOidcClient,
	createSession,
	type DexApi,
	type DexPassword,
	dexLocalSubject,
	hashSessionToken,
} from "@portikus/auth";
import {
	CookieJar,
	csrfHeaders,
	loginAs,
	type MockOidcProvider,
	startMockOidcProvider,
} from "@portikus/auth/testing";
import type { AdminUser, AdminUserList } from "@portikus/contracts";
import { createTestDb, hasTestDb, type TestDb } from "@portikus/db/testing";
import { collectingLogger } from "@portikus/observability/testing";
import bcrypt from "bcryptjs";
import type { FastifyInstance } from "fastify";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { toAuthOptions } from "../auth-options.js";
import { buildServer } from "../server.js";
import { buildTestServer, PUBLIC_URL, testConfig } from "../test-support.js";

/**
 * The Dex user routes (docs/archive/epics/EPIC-14.md rulings 21, 22 and 24) against an
 * in-memory stand-in for the gRPC client. The client itself is tested
 * against a gRPC server in packages/auth.
 */

const skip = !hasTestDb();

/** Dex's passwords, by email, with a switch that makes every call fail. */
function stubDex() {
	const passwords = new Map<string, DexPassword & { hash: string }>();
	const state = { failing: false };
	const guard = () => {
		if (state.failing) throw Object.assign(new Error("unavailable"), { code: 14 });
	};
	const dex: DexApi = {
		async createPassword(input) {
			guard();
			if (passwords.has(input.email)) return "already_exists";
			passwords.set(input.email, { ...input });
			return "created";
		},
		async updatePassword(email, hash) {
			guard();
			const stored = passwords.get(email);
			if (!stored) return "not_found";
			stored.hash = hash;
			return "updated";
		},
		async deletePassword(email) {
			guard();
			return passwords.delete(email) ? "deleted" : "not_found";
		},
		async listPasswords() {
			guard();
			return [...passwords.values()].map(({ email, username, userId }) => ({
				email,
				username,
				userId,
			}));
		},
		async verifyPassword() {
			return "not_found";
		},
		close() {},
	};
	return { dex, passwords, state };
}

let testDb: TestDb;
let mock: MockOidcProvider;
let app: FastifyInstance;
let stub: ReturnType<typeof stubDex>;
let lines: Record<string, unknown>[];

beforeAll(async () => {
	if (skip) return;
	testDb = await createTestDb();
	mock = await startMockOidcProvider({
		redirectUris: [`${PUBLIC_URL}/auth/callback`],
	});
});

afterAll(async () => {
	if (skip) return;
	await testDb.close();
	await mock.close();
});

beforeEach(async () => {
	if (skip) return;
	await testDb.truncate();
	stub = stubDex();
	const collected = collectingLogger("debug");
	lines = collected.lines;
	const config = testConfig(mock.issuer);
	app = buildServer({
		db: testDb.db,
		config,
		logger: collected.logger,
		oidc: createOidcClient(toAuthOptions(config)),
		dex: stub.dex,
		previewPollIntervalMs: 50,
	});
	await app.ready();
	return async () => {
		await app.close();
	};
});

async function adminJar(): Promise<CookieJar> {
	const jar = new CookieJar();
	await loginAs(app, "carol", jar);
	return jar;
}

function post(jar: CookieJar, url: string, payload?: object) {
	return app.inject({
		method: "POST",
		url,
		headers: csrfHeaders(jar, PUBLIC_URL),
		...(payload ? { payload } : {}),
	});
}

async function addUser(
	jar: CookieJar,
	body: { name: string; email: string; username: string; role: string },
): Promise<{ user: AdminUser; password: string }> {
	const res = await post(jar, "/admin/dex-users", body);
	expect(res.statusCode).toBe(200);
	return res.json();
}

/** A session and a preview session for the account, as a signed-in user has. */
async function openSessions(userId: string): Promise<void> {
	const session = await createSession(testDb.db, userId, 3600, {
		method: "oidc",
		courseUserId: null,
	});
	const workspaceId = crypto.randomUUID();
	await testDb.db
		.insertInto("workspaces")
		.values({
			id: workspaceId,
			owner_user_id: userId,
			incus_instance_name: `ws-${workspaceId.slice(0, 8)}`,
			label: `dex-${workspaceId.slice(0, 8)}`,
			state: "stopped",
			desired_state: "stopped",
		})
		.execute();
	await testDb.db
		.insertInto("preview_sessions")
		.values({
			token_hash: `hash-${workspaceId}`,
			user_id: userId,
			session_id: hashSessionToken(session.token),
			workspace_id: workspaceId,
			port: 3000,
			preview_host: "x.preview.localhost",
		})
		.execute();
}

async function openPreviewSessions(userId: string) {
	return testDb.db
		.selectFrom("preview_sessions")
		.select("id")
		.where("user_id", "=", userId)
		.where("revoked_at", "is", null)
		.execute();
}

async function auditRows(action: string) {
	return testDb.db
		.selectFrom("audit_events")
		.select(["actor", "target", "result", "metadata"])
		.where("action", "=", action)
		.orderBy("id")
		.execute();
}

async function carolId(): Promise<string> {
	const row = await testDb.db
		.selectFrom("users")
		.select("id")
		.where("oidc_subject", "=", "carol")
		.executeTakeFirstOrThrow();
	return row.id;
}

/** Make the next commit of a users row with this email fail, as a lost database would. */
async function failCommitFor(email: string): Promise<() => Promise<void>> {
	await sql`create function doom() returns trigger language plpgsql as $$
		begin raise exception 'commit refused'; end $$`.execute(testDb.db);
	await sql
		.raw(
			`create constraint trigger doom after insert on users deferrable initially deferred
			for each row when (lower(new.email) = lower('${email}')) execute function doom()`,
		)
		.execute(testDb.db);
	return async () => {
		await sql`drop trigger doom on users`.execute(testDb.db);
		await sql`drop function doom()`.execute(testDb.db);
	};
}

describe.skipIf(skip)("Add user", () => {
	test("creates the Dex password and pre-creates the account under Dex's subject", async () => {
		const carol = await adminJar();
		const { user, password } = await addUser(carol, {
			name: "  Dana Kim ",
			email: "Dana@Example.edu",
			username: "dana",
			role: "student",
		});
		expect(password).toMatch(/^[A-Za-z0-9]{20}$/);
		const stored = stub.passwords.get("dana@example.edu");
		expect(stored?.username).toBe("dana");
		expect(await bcrypt.compare(password, stored?.hash ?? "")).toBe(true);
		expect(stored?.hash).toMatch(/^\$2[aby]\$10\$/);

		const row = await testDb.db
			.selectFrom("users")
			.select([
				"oidc_issuer",
				"oidc_subject",
				"email",
				"display_name",
				"preferred_username",
				"role",
				"provider_role",
				"granted_role",
				"must_change_password",
			])
			.where("id", "=", user.id)
			.executeTakeFirstOrThrow();
		// They choose their own password at first sign-in (docs/EPIC-14-2.md ruling 17).
		expect(row).toEqual({
			oidc_issuer: mock.issuer,
			oidc_subject: dexLocalSubject(stored?.userId ?? ""),
			email: "dana@example.edu",
			display_name: "Dana Kim",
			preferred_username: "dana",
			role: "student",
			provider_role: "student",
			granted_role: null,
			must_change_password: true,
		});
		expect(user).toMatchObject({ dexLocal: true, role: "student", grantedRole: null });
	});

	test("a chosen instructor or administrator role is a grant", async () => {
		const carol = await adminJar();
		for (const role of ["instructor", "administrator"] as const) {
			const { user } = await addUser(carol, {
				name: `${role} Person`,
				email: `${role}@example.edu`,
				username: role,
				role,
			});
			expect(user).toMatchObject({ role, providerRole: "student", grantedRole: role });
		}
	});

	test("the password is in that one response only: not stored, logged or audited", async () => {
		const carol = await adminJar();
		const { user, password } = await addUser(carol, {
			name: "Erin-Dex Person",
			email: "erin.dex@example.edu",
			username: "erin-dex",
			role: "student",
		});
		const list = await app.inject({
			url: "/admin/users",
			headers: { cookie: carol.cookieHeader() },
		});
		expect(list.body).not.toContain(password);
		expect(JSON.stringify(lines)).not.toContain(password);
		const hash = stub.passwords.get("erin.dex@example.edu")?.hash ?? "";
		expect(JSON.stringify(lines)).not.toContain(hash);

		const audits = await auditRows("dex_user.created");
		expect(audits).toEqual([
			{
				actor: `user:${await carolId()}`,
				target: user.id,
				result: "ok",
				metadata: {
					role: "student",
					ip: expect.any(String),
					userAgent: expect.any(String),
				},
			},
		]);
		const text = JSON.stringify(audits);
		expect(text).not.toContain(password);
		expect(text).not.toContain("erin.dex@example.edu");
	});

	test("a taken email is 409 and leaves no account behind", async () => {
		const carol = await adminJar();
		await addUser(carol, {
			name: "Twice Person",
			email: "twice@example.edu",
			username: "twice",
			role: "student",
		});
		const res = await post(carol, "/admin/dex-users", {
			name: "Again Person",
			email: "twice@example.edu",
			username: "again",
			role: "instructor",
		});
		expect(res.statusCode).toBe(409);
		expect(res.json().code).toBe("DEX_USER_EXISTS");
		const rows = await testDb.db
			.selectFrom("users")
			.select("id")
			.where("email", "=", "twice@example.edu")
			.execute();
		expect(rows).toHaveLength(1);
		expect(await auditRows("dex_user.created")).toHaveLength(1);
	});

	test("refuses a missing or blank name, a bad email, username, role or extra field", async () => {
		const carol = await adminJar();
		for (const body of [
			{ email: "ok@example.edu", username: "ok", role: "student" },
			{ name: "  ", email: "ok@example.edu", username: "ok", role: "student" },
			{
				name: "x".repeat(101),
				email: "ok@example.edu",
				username: "ok",
				role: "student",
			},
			{ name: "Ok Person", email: "not-an-email", username: "ok", role: "student" },
			{
				name: "Ok Person",
				email: "ok@example.edu",
				username: "has space",
				role: "student",
			},
			{ name: "Ok Person", email: "ok@example.edu", username: "", role: "student" },
			{ name: "Ok Person", email: "ok@example.edu", username: "ok", role: "owner" },
			{
				name: "Ok Person",
				email: "ok@example.edu",
				username: "ok",
				role: "student",
				hash: "x",
			},
		]) {
			const res = await post(carol, "/admin/dex-users", body);
			expect(res.statusCode, JSON.stringify(body)).toBe(400);
		}
		expect(stub.passwords.size).toBe(0);
	});

	test("a failed commit after Dex made the password removes that password", async () => {
		const carol = await adminJar();
		const undo = await failCommitFor("lost@example.edu");
		try {
			const res = await post(carol, "/admin/dex-users", {
				name: "Lost Person",
				email: "lost@example.edu",
				username: "lost",
				role: "student",
			});
			expect(res.statusCode).toBe(500);
		} finally {
			await undo();
		}
		expect(stub.passwords.has("lost@example.edu")).toBe(false);
		// So adding the same email again works rather than answering 409 for ever.
		const again = await post(carol, "/admin/dex-users", {
			name: "Lost Person",
			email: "lost@example.edu",
			username: "lost",
			role: "student",
		});
		expect(again.statusCode).toBe(200);
	});

	test("Dex being down is 503 and leaves no account behind", async () => {
		const carol = await adminJar();
		stub.state.failing = true;
		const res = await post(carol, "/admin/dex-users", {
			name: "Down Person",
			email: "down@example.edu",
			username: "down",
			role: "student",
		});
		expect(res.statusCode).toBe(503);
		expect(res.json().code).toBe("DEX_UNAVAILABLE");
		const rows = await testDb.db
			.selectFrom("users")
			.select("id")
			.where("email", "=", "down@example.edu")
			.execute();
		expect(rows).toEqual([]);
	});

	test("needs the CSRF check and an administrator", async () => {
		const carol = await adminJar();
		const noCsrf = await app.inject({
			method: "POST",
			url: "/admin/dex-users",
			headers: { cookie: carol.cookieHeader() },
			payload: {
				name: "Ok Person",
				email: "x@example.edu",
				username: "x",
				role: "student",
			},
		});
		expect(noCsrf.statusCode).toBe(403);
		const alice = new CookieJar();
		await loginAs(app, "alice", alice);
		const student = await post(alice, "/admin/dex-users", {
			name: "X Person",
			email: "x@example.edu",
			username: "x",
			role: "student",
		});
		expect(student.statusCode).toBe(403);
		expect(stub.passwords.size).toBe(0);
	});
});

describe.skipIf(skip)("the account list", () => {
	test("marks Dex local passwords and says the site manages them", async () => {
		const carol = await adminJar();
		const { user } = await addUser(carol, {
			name: "Gus Person",
			email: "gus@example.edu",
			username: "gus",
			role: "student",
		});
		const res = await app.inject({
			url: "/admin/users",
			headers: { cookie: carol.cookieHeader() },
		});
		const body = res.json() as AdminUserList;
		expect(body.dexUsers).toBe(true);
		const byId = new Map(body.users.map((u) => [u.id, u]));
		expect(byId.get(user.id)?.dexLocal).toBe(true);
		expect(byId.get(await carolId())?.dexLocal).toBe(false);

		// A password gone from Dex is no longer offered for reset or removal.
		stub.passwords.clear();
		const after = (
			await app.inject({
				url: "/admin/users",
				headers: { cookie: carol.cookieHeader() },
			})
		).json() as AdminUserList;
		expect(after.users.find((u) => u.id === user.id)?.dexLocal).toBe(false);
	});

	test("still loads while Dex is down", async () => {
		const carol = await adminJar();
		stub.state.failing = true;
		const res = await app.inject({
			url: "/admin/users",
			headers: { cookie: carol.cookieHeader() },
		});
		expect(res.statusCode).toBe(200);
	});
});

describe.skipIf(skip)("Reset password", () => {
	test("sets a new password, shown once, and ends the account's sessions", async () => {
		const carol = await adminJar();
		const { user, password: first } = await addUser(carol, {
			name: "Hal Person",
			email: "hal@example.edu",
			username: "hal",
			role: "student",
		});
		await openSessions(user.id);
		// As if they had already chosen their own password.
		await testDb.db
			.updateTable("users")
			.set({ must_change_password: false })
			.where("id", "=", user.id)
			.execute();
		const res = await post(carol, `/admin/dex-users/${user.id}/reset-password`);
		expect(res.statusCode).toBe(200);
		const { password } = res.json() as { password: string };
		const flag = await testDb.db
			.selectFrom("users")
			.select("must_change_password")
			.where("id", "=", user.id)
			.executeTakeFirstOrThrow();
		expect(flag.must_change_password).toBe(true);
		expect(password).toMatch(/^[A-Za-z0-9]{20}$/);
		expect(password).not.toBe(first);
		const hash = stub.passwords.get("hal@example.edu")?.hash ?? "";
		expect(await bcrypt.compare(password, hash)).toBe(true);
		expect(await bcrypt.compare(first, hash)).toBe(false);

		const sessions = await testDb.db
			.selectFrom("sessions")
			.select("id")
			.where("user_id", "=", user.id)
			.execute();
		expect(sessions).toEqual([]);
		expect(await openPreviewSessions(user.id)).toEqual([]);

		expect(await auditRows("dex_user.password_reset")).toEqual([
			{
				actor: `user:${await carolId()}`,
				target: user.id,
				result: "ok",
				metadata: { ip: expect.any(String), userAgent: expect.any(String) },
			},
		]);
		expect(JSON.stringify(lines)).not.toContain(password);
	});

	test("refuses the administrator's own account and keeps their sessions", async () => {
		const carol = await adminJar();
		const id = await carolId();
		const dexUserId = crypto.randomUUID();
		await testDb.db
			.updateTable("users")
			.set({ oidc_subject: dexLocalSubject(dexUserId) })
			.where("id", "=", id)
			.execute();
		stub.passwords.set("carol@example.edu", {
			email: "carol@example.edu",
			username: "carol",
			userId: dexUserId,
			hash: "$2b$10$x",
		});
		const res = await post(carol, `/admin/dex-users/${id}/reset-password`);
		expect(res.statusCode).toBe(400);
		expect(res.json()).toMatchObject({
			code: "VALIDATION_FAILED",
			message: "You cannot reset your own password here.",
		});
		expect(stub.passwords.get("carol@example.edu")?.hash).toBe("$2b$10$x");
		const sessions = await testDb.db
			.selectFrom("sessions")
			.select("id")
			.where("user_id", "=", id)
			.execute();
		expect(sessions.length).toBeGreaterThan(0);
		expect(await auditRows("dex_user.password_reset")).toEqual([]);
	});

	test("refuses an account with no Dex password; a missing one is 404", async () => {
		const carol = await adminJar();
		const sso = await testDb.db
			.insertInto("users")
			.values({
				oidc_issuer: mock.issuer,
				oidc_subject: "sso-only",
				email: "sso@example.edu",
				display_name: "SSO",
				role: "student",
				provider_role: "student",
			})
			.returning("id")
			.executeTakeFirstOrThrow();
		const res = await post(carol, `/admin/dex-users/${sso.id}/reset-password`);
		expect(res.statusCode).toBe(400);
		expect(res.json().message).toBe("This account has no Dex password.");
		const missing = await post(
			carol,
			`/admin/dex-users/${crypto.randomUUID()}/reset-password`,
		);
		expect(missing.statusCode).toBe(404);
		const bad = await post(carol, "/admin/dex-users/not-a-uuid/reset-password");
		expect(bad.statusCode).toBe(400);
	});

	test("Dex being down is 503 and keeps the sessions", async () => {
		const carol = await adminJar();
		const { user } = await addUser(carol, {
			name: "Ivy Person",
			email: "ivy@example.edu",
			username: "ivy",
			role: "student",
		});
		await openSessions(user.id);
		stub.state.failing = true;
		const res = await post(carol, `/admin/dex-users/${user.id}/reset-password`);
		expect(res.statusCode).toBe(503);
		const sessions = await testDb.db
			.selectFrom("sessions")
			.select("id")
			.where("user_id", "=", user.id)
			.execute();
		expect(sessions).toHaveLength(1);
		expect(await openPreviewSessions(user.id)).toHaveLength(1);
	});
});

describe.skipIf(skip)("Remove", () => {
	test("deletes the Dex password and disables the account, ending its sessions", async () => {
		const carol = await adminJar();
		const { user } = await addUser(carol, {
			name: "Jo Person",
			email: "jo@example.edu",
			username: "jo",
			role: "student",
		});
		await openSessions(user.id);
		const res = await post(carol, `/admin/dex-users/${user.id}/remove`);
		expect(res.statusCode).toBe(200);
		expect(res.json()).toMatchObject({ id: user.id, dexLocal: false });
		expect((res.json() as AdminUser).disabledAt).not.toBeNull();
		expect(stub.passwords.has("jo@example.edu")).toBe(false);
		const sessions = await testDb.db
			.selectFrom("sessions")
			.select("id")
			.where("user_id", "=", user.id)
			.execute();
		expect(sessions).toEqual([]);
		expect(await openPreviewSessions(user.id)).toEqual([]);
		// The workspace stays for an administrator to archive.
		const workspaces = await testDb.db
			.selectFrom("workspaces")
			.select("archived_at")
			.where("owner_user_id", "=", user.id)
			.execute();
		expect(workspaces).toEqual([{ archived_at: null }]);
		expect(await auditRows("dex_user.removed")).toEqual([
			{
				actor: `user:${await carolId()}`,
				target: user.id,
				result: "ok",
				metadata: { ip: expect.any(String), userAgent: expect.any(String) },
			},
		]);
		expect(await auditRows("user.disabled")).toHaveLength(1);
	});

	test("refuses the administrator's own account and leaves Dex alone", async () => {
		const carol = await adminJar();
		const id = await carolId();
		// Make carol's own account a Dex local password.
		const dexUserId = crypto.randomUUID();
		await testDb.db
			.updateTable("users")
			.set({ oidc_subject: dexLocalSubject(dexUserId) })
			.where("id", "=", id)
			.execute();
		stub.passwords.set("carol@example.edu", {
			email: "carol@example.edu",
			username: "carol",
			userId: dexUserId,
			hash: "$2b$10$x",
		});
		const res = await post(carol, `/admin/dex-users/${id}/remove`);
		expect(res.statusCode).toBe(400);
		expect(res.json().message).toBe("You cannot disable your own account.");
		expect(stub.passwords.has("carol@example.edu")).toBe(true);
		expect(await auditRows("dex_user.removed")).toEqual([]);
	});

	test("Dex being down is 503 and the account stays enabled", async () => {
		const carol = await adminJar();
		const { user } = await addUser(carol, {
			name: "Lee Person",
			email: "lee@example.edu",
			username: "lee",
			role: "student",
		});
		const passwords = [...stub.passwords.values()];
		// The list answers, the delete does not.
		stub.dex.deletePassword = async () => {
			throw Object.assign(new Error("unavailable"), { code: 14 });
		};
		const res = await post(carol, `/admin/dex-users/${user.id}/remove`);
		expect(res.statusCode).toBe(503);
		const row = await testDb.db
			.selectFrom("users")
			.select("disabled_at")
			.where("id", "=", user.id)
			.executeTakeFirstOrThrow();
		expect(row.disabled_at).toBeNull();
		expect(await auditRows("dex_user.removed")).toEqual([]);
		expect([...stub.passwords.values()]).toEqual(passwords);
	});

	test("refuses an account with no Dex password", async () => {
		const carol = await adminJar();
		const res = await post(carol, `/admin/dex-users/${await carolId()}/remove`);
		expect(res.statusCode).toBe(400);
	});
});

describe.skipIf(skip)("a site without Dex's gRPC API", () => {
	test("answers 404 to an administrator and lists no Dex users", async () => {
		const plain = buildTestServer(testDb.db, mock.issuer);
		await plain.ready();
		try {
			const carol = new CookieJar();
			await loginAs(plain, "carol", carol);
			for (const url of [
				"/admin/dex-users",
				`/admin/dex-users/${crypto.randomUUID()}/reset-password`,
				`/admin/dex-users/${crypto.randomUUID()}/remove`,
			]) {
				const res = await plain.inject({
					method: "POST",
					url,
					headers: csrfHeaders(carol, PUBLIC_URL),
					payload: {
						name: "Ok Person",
						email: "x@example.edu",
						username: "x",
						role: "student",
					},
				});
				expect(res.statusCode, url).toBe(404);
			}
			const list = await plain.inject({
				url: "/admin/users",
				headers: { cookie: carol.cookieHeader() },
			});
			const body = list.json() as AdminUserList;
			expect(body.dexUsers).toBe(false);
			expect(body.users.every((u) => !u.dexLocal)).toBe(true);
		} finally {
			await plain.close();
		}
	});
});
