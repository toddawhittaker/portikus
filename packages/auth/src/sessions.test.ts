import { createTestDb, hasTestDb, type TestDb } from "@portikus/db/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import {
	createSession,
	deleteSession,
	loadSession,
	type OidcIdentity,
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

	test.skipIf(!hasTestDb())(
		"upsertUser creates then updates the same user",
		async () => {
			const created = await upsertUser(t.db, identity, "student");
			expect(created.displayName).toBe("Alice Student");
			expect(created.role).toBe("student");

			const updated = await upsertUser(
				t.db,
				{ ...identity, displayName: "Alice Admin", email: "alice@new.example.edu" },
				"administrator",
			);
			expect(updated.id).toBe(created.id);
			expect(updated.displayName).toBe("Alice Admin");
			expect(updated.email).toBe("alice@new.example.edu");
			expect(updated.role).toBe("administrator");

			const rows = await t.db
				.selectFrom("users")
				.select(["id", "last_login_at"])
				.execute();
			expect(rows).toHaveLength(1);
			expect(rows[0]?.last_login_at).toBeInstanceOf(Date);
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
			const { token, expiresAt } = await createSession(t.db, user.id, 3600);

			expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
			const stored = await t.db
				.selectFrom("sessions")
				.select("id")
				.executeTakeFirstOrThrow();
			expect(stored.id).not.toBe(token);
			expect(stored.id).toMatch(/^[0-9a-f]{64}$/);

			const { disabledAt: _disabledAt, ...expected } = user;
			const loaded = await loadSession(t.db, token);
			expect(loaded).toEqual(expected);
		},
	);

	test.skipIf(!hasTestDb())("an unknown token loads nothing", async () => {
		expect(await loadSession(t.db, "not-a-token")).toBeNull();
	});

	test.skipIf(!hasTestDb())("an expired session is refused and removed", async () => {
		const user = await upsertUser(t.db, identity, "student");
		const { token } = await createSession(t.db, user.id, -1);

		expect(await loadSession(t.db, token)).toBeNull();
		const rows = await t.db.selectFrom("sessions").select("id").execute();
		expect(rows).toHaveLength(0);
	});

	test.skipIf(!hasTestDb())("a disabled user is refused immediately", async () => {
		const user = await upsertUser(t.db, identity, "student");
		const { token } = await createSession(t.db, user.id, 3600);
		expect(await loadSession(t.db, token)).not.toBeNull();

		await t.db
			.updateTable("users")
			.set({ disabled_at: new Date().toISOString() })
			.where("id", "=", user.id)
			.execute();

		expect(await loadSession(t.db, token)).toBeNull();
	});

	test.skipIf(!hasTestDb())("deleteSession logs the user out", async () => {
		const user = await upsertUser(t.db, identity, "student");
		const { token } = await createSession(t.db, user.id, 3600);

		await deleteSession(t.db, token);

		expect(await loadSession(t.db, token)).toBeNull();
		expect(await t.db.selectFrom("sessions").select("id").execute()).toHaveLength(0);
	});

	test.skipIf(!hasTestDb())("creating a session sweeps expired rows", async () => {
		const user = await upsertUser(t.db, identity, "student");
		const { token: stale } = await createSession(t.db, user.id, -1);
		await createSession(t.db, user.id, 3600);

		expect(await loadSession(t.db, stale)).toBeNull();
		expect(await t.db.selectFrom("sessions").select("id").execute()).toHaveLength(1);
	});
});
