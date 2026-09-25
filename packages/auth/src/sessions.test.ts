import { createTestDb, hasTestDb, type TestDb } from "@portikus/db/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import {
	createSession,
	deleteSession,
	hashSessionToken,
	loadSession,
	type OidcIdentity,
	sessionOrigin,
	upsertUser,
} from "./sessions.js";

if (!hasTestDb()) {
	console.log(
		"TEST_DATABASE_URL is not set — skipping session tests. " +
			"See docs/WORKFLOW.md for how to run a local Postgres.",
	);
}

const identity: OidcIdentity = {
	issuer: "https://idp.example.edu",
	subject: "alice",
	email: "alice@example.edu",
	displayName: "Alice Student",
	preferredUsername: "alice",
};

describe("users and sessions", () => {
	let t: TestDb;

	beforeAll(async () => {
		if (hasTestDb()) {
			t = await createTestDb();
		}
	});

	afterAll(async () => {
		await t?.close();
	});

	beforeEach(async () => {
		if (hasTestDb()) {
			await t.truncate();
		}
	});

	async function roles(id: string) {
		return t.db
			.selectFrom("users")
			.select(["role", "provider_role", "granted_role"])
			.where("id", "=", id)
			.executeTakeFirstOrThrow();
	}

	/** Store a grant as promote does: the grant and the effective role together. */
	async function grant(id: string, role: "instructor" | "administrator") {
		const row = await roles(id);
		const effective = row.provider_role === "administrator" ? "administrator" : role;
		await t.db
			.updateTable("users")
			.set({ granted_role: role, role: effective })
			.where("id", "=", id)
			.execute();
	}

	test.skipIf(!hasTestDb())(
		"upsertUser creates then updates the same user",
		async () => {
			const created = await upsertUser(t.db, identity, "student");
			expect(created.displayName).toBe("Alice Student");
			expect(created.role).toBe("student");
			expect(created.previousRole).toBeNull();

			const updated = await upsertUser(
				t.db,
				{ ...identity, displayName: "Alice Admin", email: "alice@new.example.edu" },
				"administrator",
			);
			expect(updated.id).toBe(created.id);
			expect(updated.displayName).toBe("Alice Admin");
			expect(updated.email).toBe("alice@new.example.edu");
			expect(updated.role).toBe("administrator");
			expect(updated.previousRole).toBe("student");

			const rows = await t.db
				.selectFrom("users")
				.select(["id", "last_login_at"])
				.execute();
			expect(rows).toHaveLength(1);
			expect(rows[0]?.last_login_at).toBeInstanceOf(Date);
		},
	);

	async function usernameOf(id: string) {
		const row = await t.db
			.selectFrom("users")
			.select("preferred_username")
			.where("id", "=", id)
			.executeTakeFirstOrThrow();
		return row.preferred_username;
	}

	test.skipIf(!hasTestDb())(
		"a sign-in without a username keeps the stored one",
		async () => {
			const user = await upsertUser(
				t.db,
				{ ...identity, preferredUsername: "alice" },
				"student",
			);
			await upsertUser(t.db, { ...identity, preferredUsername: null }, "student");
			expect(await usernameOf(user.id)).toBe("alice");
		},
	);

	test.skipIf(!hasTestDb())(
		"a sign-in whose name is only the stored username keeps the stored display name",
		async () => {
			// A Dex password sign-in: name is the username, no preferred_username.
			const user = await upsertUser(t.db, identity, "student");
			const again = await upsertUser(
				t.db,
				{ ...identity, displayName: "alice", preferredUsername: null },
				"student",
			);
			expect(again.id).toBe(user.id);
			expect(again.displayName).toBe("Alice Student");
		},
	);

	test.skipIf(!hasTestDb())(
		"a sign-in with a username replaces the stored one",
		async () => {
			const user = await upsertUser(
				t.db,
				{ ...identity, preferredUsername: "alice" },
				"student",
			);
			await upsertUser(t.db, { ...identity, preferredUsername: "alice2" }, "student");
			expect(await usernameOf(user.id)).toBe("alice2");
		},
	);

	test.skipIf(!hasTestDb())(
		"the same subject at another issuer is another user",
		async () => {
			const first = await upsertUser(t.db, identity, "student");
			const second = await upsertUser(
				t.db,
				{ ...identity, issuer: "https://other.example.edu" },
				"student",
			);
			expect(second.id).not.toBe(first.id);
		},
	);

	test.skipIf(!hasTestDb())(
		"a session round trips and stores only a hash",
		async () => {
			const user = await upsertUser(t.db, identity, "student");
			const { token, expiresAt } = await createSession(t.db, user.id, 3600, {
				method: "oidc",
				courseUserId: null,
			});

			expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
			const stored = await t.db
				.selectFrom("sessions")
				.select("id")
				.executeTakeFirstOrThrow();
			expect(stored.id).not.toBe(token);
			expect(stored.id).toMatch(/^[0-9a-f]{64}$/);

			const {
				disabledAt: _disabledAt,
				previousRole: _previousRole,
				...expected
			} = user;
			const loaded = await loadSession(t.db, token);
			expect(loaded).toEqual(expected);
		},
	);

	test.skipIf(!hasTestDb())("an unknown token loads nothing", async () => {
		expect(await loadSession(t.db, "not-a-token")).toBeNull();
	});

	test.skipIf(!hasTestDb())("an expired session is refused and removed", async () => {
		const user = await upsertUser(t.db, identity, "student");
		const { token } = await createSession(t.db, user.id, -1, {
			method: "oidc",
			courseUserId: null,
		});

		expect(await loadSession(t.db, token)).toBeNull();
		const rows = await t.db.selectFrom("sessions").select("id").execute();
		expect(rows).toHaveLength(0);
	});

	test.skipIf(!hasTestDb())("a disabled user is refused immediately", async () => {
		const user = await upsertUser(t.db, identity, "student");
		const { token } = await createSession(t.db, user.id, 3600, {
			method: "oidc",
			courseUserId: null,
		});
		expect(await loadSession(t.db, token)).not.toBeNull();

		await t.db
			.updateTable("users")
			.set({ disabled_at: new Date().toISOString() })
			.where("id", "=", user.id)
			.execute();

		expect(await loadSession(t.db, token)).toBeNull();
	});

	test.skipIf(!hasTestDb())(
		"sign-in with no grant: role and provider_role are the provider's role",
		async () => {
			const user = await upsertUser(t.db, identity, "instructor");
			expect(user.role).toBe("instructor");
			expect(await roles(user.id)).toEqual({
				role: "instructor",
				provider_role: "instructor",
				granted_role: null,
			});
			const again = await upsertUser(t.db, identity, "student");
			expect(again.role).toBe("student");
			expect(again.previousRole).toBe("instructor");
		},
	);

	test.skipIf(!hasTestDb())(
		"an instructor grant lifts a student but not an administrator",
		async () => {
			const user = await upsertUser(t.db, identity, "student");
			await grant(user.id, "instructor");

			const asStudent = await upsertUser(t.db, identity, "student");
			expect(asStudent.role).toBe("instructor");
			expect(await roles(user.id)).toEqual({
				role: "instructor",
				provider_role: "student",
				granted_role: "instructor",
			});

			const asAdmin = await upsertUser(t.db, identity, "administrator");
			expect(asAdmin.role).toBe("administrator");
			expect(await roles(user.id)).toEqual({
				role: "administrator",
				provider_role: "administrator",
				granted_role: "instructor",
			});
		},
	);

	test.skipIf(!hasTestDb())(
		"an administrator grant survives a sign-in whose groups say student",
		async () => {
			const user = await upsertUser(t.db, identity, "student");
			await grant(user.id, "administrator");
			const signedIn = await upsertUser(t.db, identity, "student");
			expect(signedIn.role).toBe("administrator");
			expect(signedIn.previousRole).toBe("administrator");
			expect(await roles(user.id)).toEqual({
				role: "administrator",
				provider_role: "student",
				granted_role: "administrator",
			});
		},
	);

	test.skipIf(!hasTestDb())(
		"a course account retired by a link cannot load a session",
		async () => {
			const sso = await upsertUser(t.db, identity, "student");
			const course = await upsertUser(
				t.db,
				{ ...identity, issuer: "lti:https://lms.example.edu", subject: "c-1" },
				"student",
			);
			const { token } = await createSession(t.db, course.id, 3600, {
				method: "oidc",
				courseUserId: null,
			});
			const { token: ssoToken } = await createSession(t.db, sso.id, 3600, {
				method: "oidc",
				courseUserId: null,
			});
			expect(await loadSession(t.db, token)).not.toBeNull();

			await t.db
				.insertInto("account_links")
				.values({
					course_user_id: course.id,
					user_id: sso.id,
					platform_issuer: "https://lms.example.edu",
					archived_at: null,
				})
				.execute();

			expect(await loadSession(t.db, token)).toBeNull();
			expect((await loadSession(t.db, ssoToken))?.id).toBe(sso.id);
		},
	);

	test("hashSessionToken gives the stored session id", () => {
		expect(hashSessionToken("abc")).toBe(
			"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
		);
	});

	test.skipIf(!hasTestDb())(
		"createSession records how the session started",
		async () => {
			const sso = await upsertUser(t.db, identity, "student");
			const course = await upsertUser(
				t.db,
				{ ...identity, issuer: "lti:https://lms.example.edu", subject: "c-1" },
				"student",
			);
			const { token } = await createSession(t.db, sso.id, 3600, {
				method: "lti",
				courseUserId: course.id,
			});
			expect(await sessionOrigin(t.db, hashSessionToken(token))).toEqual({
				method: "lti",
				courseUserId: course.id,
			});
			expect(await sessionOrigin(t.db, "missing")).toBeNull();
		},
	);

	test.skipIf(!hasTestDb())(
		"a launch session dies once its account is promoted to administrator",
		async () => {
			const user = await upsertUser(t.db, identity, "student");
			const lti = await createSession(t.db, user.id, 3600, {
				method: "lti",
				courseUserId: null,
			});
			const sso = await createSession(t.db, user.id, 3600, {
				method: "oidc",
				courseUserId: null,
			});
			expect(await loadSession(t.db, lti.token)).not.toBeNull();
			await grant(user.id, "administrator");
			expect(await loadSession(t.db, lti.token)).toBeNull();
			expect((await loadSession(t.db, sso.token))?.role).toBe("administrator");
		},
	);

	test.skipIf(!hasTestDb())(
		"a provider-group promotion at sign-in also kills launch sessions",
		async () => {
			const user = await upsertUser(t.db, identity, "student");
			const lti = await createSession(t.db, user.id, 3600, {
				method: "lti",
				courseUserId: null,
			});
			const link = await createSession(t.db, user.id, 3600, {
				method: "link",
				courseUserId: null,
			});
			await upsertUser(t.db, identity, "administrator");
			expect(await loadSession(t.db, lti.token)).toBeNull();
			expect((await loadSession(t.db, link.token))?.role).toBe("administrator");
		},
	);

	test.skipIf(!hasTestDb())("deleteSession logs the user out", async () => {
		const user = await upsertUser(t.db, identity, "student");
		const { token } = await createSession(t.db, user.id, 3600, {
			method: "oidc",
			courseUserId: null,
		});

		await deleteSession(t.db, token);

		expect(await loadSession(t.db, token)).toBeNull();
		expect(await t.db.selectFrom("sessions").select("id").execute()).toHaveLength(0);
	});

	test.skipIf(!hasTestDb())("creating a session sweeps expired rows", async () => {
		const user = await upsertUser(t.db, identity, "student");
		const { token: stale } = await createSession(t.db, user.id, -1, {
			method: "oidc",
			courseUserId: null,
		});
		await createSession(t.db, user.id, 3600, { method: "oidc", courseUserId: null });

		expect(await loadSession(t.db, stale)).toBeNull();
		expect(await t.db.selectFrom("sessions").select("id").execute()).toHaveLength(1);
	});
});
