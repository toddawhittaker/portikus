import { API_KEY_PREFIX } from "@portikus/contracts";
import {
	createTestDb,
	hasTestDb,
	insertTestUser,
	type TestDb,
} from "@portikus/db/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import {
	allowedKeyPeriods,
	bearerApiKey,
	type CreateKeyInput,
	createApiKey,
	expireApiKeys,
	hashApiKey,
	listApiKeys,
	listApiKeysForAdmin,
	renewApiKey,
	resolveApiKey,
	revokeApiKeys,
	touchApiKey,
} from "./api-keys.js";
import { DEX_ACCOUNT_ISSUER, dexLocalSubject } from "./dex-subject.js";

/** API keys (SPEC.md sections 24.8 and 24.13, decisions D1 and D5). */

const DAY = 24 * 3600 * 1000;

describe("bearerApiKey", () => {
	test.each([
		["Bearer portikus_abc", "portikus_abc"],
		["bearer portikus_abc", "portikus_abc"],
		["Bearer   portikus_abc", "portikus_abc"],
	])("%s is a key", (header, key) => {
		expect(bearerApiKey(header)).toBe(key);
	});

	test.each([
		undefined,
		"",
		"Bearer other_token",
		"Basic portikus_abc",
		"portikus_abc",
		"Bearer portikus_abc extra",
	])("%s is not", (header) => {
		expect(bearerApiKey(header)).toBeNull();
	});
});

describe("allowedKeyPeriods (decision D5)", () => {
	test("a Dex local-password account may choose, an SSO or course account gets 30 days", () => {
		expect(
			allowedKeyPeriods({
				oidc_issuer: DEX_ACCOUNT_ISSUER,
				oidc_subject: dexLocalSubject("u1"),
			}),
		).toEqual([7, 30, 90, null]);
		expect(
			allowedKeyPeriods({
				oidc_issuer: "https://idp.example.edu",
				oidc_subject: "alice",
			}),
		).toEqual([30]);
		expect(
			allowedKeyPeriods({
				oidc_issuer: "lti:https://lms.example.edu",
				oidc_subject: dexLocalSubject("u1"),
			}),
		).toEqual([30]);
	});
});

describe.skipIf(!hasTestDb())("API key state", () => {
	let t: TestDb;

	beforeAll(async () => {
		t = await createTestDb();
	});
	afterAll(async () => {
		await t?.close();
	});
	beforeEach(async () => {
		await t.truncate();
	});

	const input: CreateKeyInput = { name: "laptop", scope: "read", periodDays: 30 };

	const instructor = () => insertTestUser(t.db, { role: "instructor" });
	const dexLocal = (role = "instructor") =>
		insertTestUser(t.db, {
			role,
			oidc_issuer: DEX_ACCOUNT_ISSUER,
			oidc_subject: dexLocalSubject(`u-${Math.random().toString(36).slice(2)}`),
		});

	async function made(userId: string, over: Partial<typeof input> = {}) {
		const r = await createApiKey(t.db, userId, { ...input, ...over });
		if (!r.ok) throw new Error(r.reason);
		return r;
	}

	describe("createApiKey", () => {
		test("returns the secret once; only its hash is stored", async () => {
			const user = await instructor();
			const { key, secret } = await made(user);
			expect(secret).toMatch(/^portikus_[A-Za-z0-9_-]{43}$/);
			expect(key.prefix).toBe(secret.slice(0, API_KEY_PREFIX.length + 4));
			expect(JSON.stringify(key)).not.toContain(secret);
			const row = await t.db
				.selectFrom("api_keys")
				.selectAll()
				.executeTakeFirstOrThrow();
			expect(row.token_hash).toBe(hashApiKey(secret));
			expect(JSON.stringify(row)).not.toContain(secret);
			expect(JSON.stringify(await listApiKeys(t.db, user))).not.toContain(secret);
		});

		test("two keys never share a secret", async () => {
			const user = await instructor();
			expect((await made(user)).secret).not.toBe((await made(user)).secret);
		});

		test("expires after its period, and never when the period is null", async () => {
			const now = new Date("2026-11-15T12:00:00Z");
			const local = await dexLocal();
			const week = await createApiKey(t.db, local, { ...input, periodDays: 7 }, now);
			const never = await createApiKey(
				t.db,
				local,
				{ ...input, periodDays: null },
				now,
			);
			expect(week.ok && week.key.expiresAt).toBe(
				new Date(now.getTime() + 7 * DAY).toISOString(),
			);
			expect(never.ok && never.key.expiresAt).toBeNull();
			expect(never.ok && never.key.state).toBe("active");
		});

		test("an SSO account may only have 30 days; a Dex local account any period", async () => {
			const sso = await instructor();
			for (const periodDays of [7, 90, null] as const) {
				expect(await createApiKey(t.db, sso, { ...input, periodDays })).toEqual({
					ok: false,
					reason: "period_not_allowed",
				});
			}
			const local = await dexLocal();
			for (const periodDays of [7, 30, 90, null] as const) {
				expect((await createApiKey(t.db, local, { ...input, periodDays })).ok).toBe(
					true,
				);
			}
		});

		test("a student, a disabled account and an unknown id are refused", async () => {
			const student = await insertTestUser(t.db);
			expect(await createApiKey(t.db, student, input)).toEqual({
				ok: false,
				reason: "not_staff",
			});
			const disabled = await insertTestUser(t.db, {
				role: "instructor",
				disabled_at: new Date().toISOString(),
			});
			expect((await createApiKey(t.db, disabled, input)).ok).toBe(false);
			expect(
				(await createApiKey(t.db, "00000000-0000-4000-8000-000000000009", input)).ok,
			).toBe(false);
		});
	});

	describe("resolveApiKey (SPEC.md section 24.13)", () => {
		test("an administrator's or instructor's key finds its owner, without a second factor", async () => {
			const admin = await insertTestUser(t.db, { role: "administrator" });
			const { key, secret } = await made(admin, { scope: "destructive" });
			const found = await resolveApiKey(t.db, secret);
			expect(found?.key).toEqual({ id: key.id, scope: "destructive" });
			expect(found?.user).toMatchObject({
				id: admin,
				role: "administrator",
				secondFactor: null,
				secondFactorApplies: false,
				mustChangePassword: false,
				mustAcceptUse: false,
			});
		});

		test("a Dex local account's key needs no second factor at use", async () => {
			const { secret } = await made(await dexLocal());
			expect((await resolveApiKey(t.db, secret))?.user.secondFactor).toBeNull();
		});

		test("the owner's pending gates still show, so the plugin can enforce them", async () => {
			const user = await instructor();
			const { secret } = await made(user);
			await t.db
				.updateTable("users")
				.set({ must_change_password: true, acceptable_use_version: 0 })
				.where("id", "=", user)
				.execute();
			expect((await resolveApiKey(t.db, secret))?.user).toMatchObject({
				mustChangePassword: true,
				mustAcceptUse: true,
			});
		});

		test("an unknown key resolves to nothing", async () => {
			expect(await resolveApiKey(t.db, "portikus_nope")).toBeNull();
		});

		test("a revoked key resolves to nothing", async () => {
			const user = await instructor();
			const { key, secret } = await made(user);
			await revokeApiKeys(t.db, { keyId: key.id }, user);
			expect(await resolveApiKey(t.db, secret)).toBeNull();
		});

		test("an expired key resolves to nothing, and a never-expiring one still does", async () => {
			const local = await dexLocal();
			const { secret } = await made(local, { periodDays: 7 });
			const never = await made(local, { periodDays: null });
			const later = new Date(Date.now() + 8 * DAY);
			expect(await resolveApiKey(t.db, secret, later)).toBeNull();
			expect(
				await resolveApiKey(t.db, never.secret, new Date(Date.now() + 5000 * DAY)),
			).not.toBeNull();
		});

		test("a key stops at the very instant it expires", async () => {
			const user = await instructor();
			const now = new Date("2026-11-15T12:00:00Z");
			const r = await createApiKey(t.db, user, input, now);
			if (!r.ok) throw new Error("create");
			const at = new Date(now.getTime() + 30 * DAY);
			expect(
				await resolveApiKey(t.db, r.secret, new Date(at.getTime() - 1)),
			).not.toBeNull();
			expect(await resolveApiKey(t.db, r.secret, at)).toBeNull();
		});

		test("a disabled owner's key stops", async () => {
			const user = await instructor();
			const { secret } = await made(user);
			await t.db
				.updateTable("users")
				.set({ disabled_at: new Date().toISOString() })
				.where("id", "=", user)
				.execute();
			expect(await resolveApiKey(t.db, secret)).toBeNull();
		});

		test("an owner who is now a student has a dead key (provider role removal, then demotion)", async () => {
			const user = await instructor();
			const { secret } = await made(user);
			await t.db
				.updateTable("users")
				.set({ role: "student" })
				.where("id", "=", user)
				.execute();
			expect(await resolveApiKey(t.db, secret)).toBeNull();
		});

		test("an owner whose role came from the provider and later lapsed keeps the key while they hold a staff role (decision D1)", async () => {
			const user = await instructor();
			const { secret } = await made(user);
			// The provider no longer sends the group; role stays until the next sign-in.
			await t.db
				.updateTable("users")
				.set({ provider_role: "student" })
				.where("id", "=", user)
				.execute();
			expect(await resolveApiKey(t.db, secret)).not.toBeNull();
		});

		test("a course account a link has retired has a dead key", async () => {
			const course = await insertTestUser(t.db, {
				role: "instructor",
				oidc_issuer: "lti:https://lms.example.edu",
			});
			const sso = await instructor();
			const { secret } = await made(course);
			await t.db
				.insertInto("account_links")
				.values({
					course_user_id: course,
					user_id: sso,
					platform_issuer: "https://lms.example.edu",
					archived_at: null,
				})
				.execute();
			expect(await resolveApiKey(t.db, secret)).toBeNull();
		});
	});

	describe("renewApiKey (decision D5)", () => {
		test("restarts the period from now with the same secret", async () => {
			const local = await dexLocal();
			const start = new Date("2026-01-01T00:00:00Z");
			const r = await createApiKey(t.db, local, { ...input, periodDays: 90 }, start);
			if (!r.ok) throw new Error("create");
			const now = new Date("2026-02-01T00:00:00Z");
			const out = await renewApiKey(t.db, local, r.key.id, { newSecret: false }, now);
			expect(out.ok && out.secret).toBeNull();
			expect(out.ok && out.key.expiresAt).toBe(
				new Date(now.getTime() + 90 * DAY).toISOString(),
			);
			expect(out.ok && out.key.prefix).toBe(r.key.prefix);
			expect(await resolveApiKey(t.db, r.secret, now)).not.toBeNull();
		});

		test("uses the key's own stored period, not the default", async () => {
			const local = await dexLocal();
			const r = await made(local, { periodDays: 7 });
			const now = new Date();
			const out = await renewApiKey(t.db, local, r.key.id, { newSecret: false }, now);
			expect(out.ok && out.key.expiresAt).toBe(
				new Date(now.getTime() + 7 * DAY).toISOString(),
			);
		});

		test("an expired key can be renewed, however long ago it expired, and then works", async () => {
			const user = await instructor();
			const r = await made(user);
			await expireApiKeys(t.db, { keyId: r.key.id });
			const later = new Date(Date.now() + 400 * DAY);
			expect(await resolveApiKey(t.db, r.secret, later)).toBeNull();
			const out = await renewApiKey(t.db, user, r.key.id, { newSecret: false }, later);
			expect(out.ok && out.key.state).toBe("active");
			expect(await resolveApiKey(t.db, r.secret, later)).not.toBeNull();
		});

		test("a never-expiring key renews to never, even after an administrator expired it", async () => {
			const local = await dexLocal();
			const r = await made(local, { periodDays: null });
			await expireApiKeys(t.db, { keyId: r.key.id });
			expect(
				await resolveApiKey(t.db, r.secret, new Date(Date.now() + 1000)),
			).toBeNull();
			const out = await renewApiKey(t.db, local, r.key.id, { newSecret: false });
			expect(out.ok && out.key.expiresAt).toBeNull();
			expect(await resolveApiKey(t.db, r.secret)).not.toBeNull();
		});

		test("a revoked key can never be renewed, and the refusal changes nothing", async () => {
			const user = await instructor();
			const r = await made(user);
			await revokeApiKeys(t.db, { keyId: r.key.id }, user);
			for (const newSecret of [false, true]) {
				expect(await renewApiKey(t.db, user, r.key.id, { newSecret })).toEqual({
					ok: false,
					reason: "revoked",
				});
			}
			expect(await resolveApiKey(t.db, r.secret)).toBeNull();
		});

		test("an expired, then revoked key cannot be renewed", async () => {
			const user = await instructor();
			const r = await made(user);
			await expireApiKeys(t.db, { keyId: r.key.id });
			await revokeApiKeys(t.db, { keyId: r.key.id }, user);
			expect((await renewApiKey(t.db, user, r.key.id, { newSecret: false })).ok).toBe(
				false,
			);
		});

		test("another person's key and an unknown key are not found", async () => {
			const owner = await instructor();
			const other = await instructor();
			const r = await made(owner);
			expect(await renewApiKey(t.db, other, r.key.id, { newSecret: false })).toEqual({
				ok: false,
				reason: "not_found",
			});
			expect(
				await renewApiKey(t.db, owner, "00000000-0000-4000-8000-000000000009", {
					newSecret: true,
				}),
			).toEqual({ ok: false, reason: "not_found" });
		});

		test("with a new secret the old one stops, the new one works, and the prefix follows", async () => {
			const user = await instructor();
			const r = await made(user);
			const out = await renewApiKey(t.db, user, r.key.id, { newSecret: true });
			if (!out.ok || out.secret === null) throw new Error("renew");
			expect(out.secret).not.toBe(r.secret);
			expect(out.key.prefix).toBe(out.secret.slice(0, API_KEY_PREFIX.length + 4));
			expect(await resolveApiKey(t.db, r.secret)).toBeNull();
			expect((await resolveApiKey(t.db, out.secret))?.key.id).toBe(r.key.id);
			const stored = await t.db
				.selectFrom("api_keys")
				.select("token_hash")
				.executeTakeFirstOrThrow();
			expect(stored.token_hash).toBe(hashApiKey(out.secret));
		});

		test("a renewal clears the reminder mark and keeps the scope and the name", async () => {
			const user = await instructor();
			const r = await made(user, { scope: "write", name: "ci" });
			await t.db
				.updateTable("api_keys")
				.set({ expiry_reminded_for: new Date() })
				.execute();
			const out = await renewApiKey(t.db, user, r.key.id, { newSecret: false });
			expect(out.ok && [out.key.scope, out.key.name]).toEqual(["write", "ci"]);
			const row = await t.db
				.selectFrom("api_keys")
				.select("expiry_reminded_for")
				.executeTakeFirstOrThrow();
			expect(row.expiry_reminded_for).toBeNull();
		});
	});

	describe("revokeApiKeys and expireApiKeys", () => {
		test("revoking records who and when, reports the key, and is final", async () => {
			const owner = await instructor();
			const admin = await insertTestUser(t.db, { role: "administrator" });
			const r = await made(owner, { name: "one" });
			const out = await revokeApiKeys(t.db, { keyId: r.key.id }, admin);
			expect(out).toEqual([{ id: r.key.id, userId: owner, name: "one" }]);
			const row = await t.db
				.selectFrom("api_keys")
				.select(["revoked_by", "revoked_at"])
				.executeTakeFirstOrThrow();
			expect(row.revoked_by).toBe(admin);
			expect(row.revoked_at).not.toBeNull();
			// A second revoke finds nothing to change.
			expect(await revokeApiKeys(t.db, { keyId: r.key.id }, admin)).toEqual([]);
			expect((await listApiKeys(t.db, owner))[0]?.state).toBe("revoked");
		});

		test("an expired key can still be revoked", async () => {
			const owner = await instructor();
			const r = await made(owner);
			await expireApiKeys(t.db, { keyId: r.key.id });
			expect(await revokeApiKeys(t.db, { keyId: r.key.id }, owner)).toHaveLength(1);
		});

		test("an owner's revoke only reaches their own key", async () => {
			const owner = await instructor();
			const other = await instructor();
			const r = await made(owner);
			expect(
				await revokeApiKeys(t.db, { keyId: r.key.id, ownerId: other }, other),
			).toEqual([]);
			expect(await resolveApiKey(t.db, r.secret)).not.toBeNull();
			expect(
				await revokeApiKeys(t.db, { keyId: r.key.id, ownerId: owner }, owner),
			).toHaveLength(1);
		});

		test("one person's keys, and every key, in one action", async () => {
			const a = await instructor();
			const b = await instructor();
			await made(a);
			await made(a);
			await made(b);
			expect(await revokeApiKeys(t.db, { userId: a }, b)).toHaveLength(2);
			expect((await listApiKeys(t.db, b))[0]?.state).toBe("active");
			expect(await revokeApiKeys(t.db, { all: true }, b)).toHaveLength(1);
			expect(await revokeApiKeys(t.db, { all: true }, b)).toEqual([]);
		});

		test("expiring stops a key now, leaves a revoked key alone, and is not repeated", async () => {
			const user = await instructor();
			const live = await made(user);
			const dead = await made(user);
			await revokeApiKeys(t.db, { keyId: dead.key.id }, user);
			const now = new Date();
			const out = await expireApiKeys(t.db, { all: true }, now);
			expect(out.map((k) => k.id)).toEqual([live.key.id]);
			expect(
				await resolveApiKey(t.db, live.secret, new Date(now.getTime() + 1)),
			).toBeNull();
			expect(
				(await listApiKeys(t.db, user, new Date(now.getTime() + 1)))
					.map((k) => k.state)
					.sort(),
			).toEqual(["expired", "revoked"]);
			expect(
				await expireApiKeys(t.db, { all: true }, new Date(now.getTime() + 5)),
			).toEqual([]);
		});

		test("expiring reaches a never-expiring key, and one person's keys only", async () => {
			const local = await dexLocal();
			const other = await instructor();
			const never = await made(local, { periodDays: null });
			const theirs = await made(other);
			const out = await expireApiKeys(t.db, { userId: local });
			expect(out.map((k) => k.id)).toEqual([never.key.id]);
			expect(await resolveApiKey(t.db, theirs.secret)).not.toBeNull();
		});
	});

	describe("lists", () => {
		test("an owner sees only their own keys, newest first, with state and no secret", async () => {
			const a = await instructor();
			const b = await instructor();
			const first = await made(a, { name: "first" });
			await made(b);
			const second = await made(a, { name: "second" });
			await t.db
				.updateTable("api_keys")
				.set({ created_at: new Date(Date.now() - 1000) })
				.where("id", "=", first.key.id)
				.execute();
			const list = await listApiKeys(t.db, a);
			expect(list.map((k) => k.name)).toEqual(["second", "first"]);
			expect(list[0]).toEqual(second.key);
			expect(JSON.stringify(list)).not.toContain(first.secret);
		});

		test("an administrator sees every key with its owner, or one person's", async () => {
			const a = await instructor();
			const admin = await insertTestUser(t.db, {
				role: "administrator",
				display_name: "Admin",
			});
			await made(a);
			await made(admin);
			const all = await listApiKeysForAdmin(t.db);
			expect(all.map((k) => k.owner.role).sort()).toEqual([
				"administrator",
				"instructor",
			]);
			expect(
				(await listApiKeysForAdmin(t.db, { userId: a })).map((k) => k.owner.id),
			).toEqual([a]);
			expect(all.find((k) => k.owner.id === admin)?.owner.displayName).toBe("Admin");
		});
	});

	describe("touchApiKey", () => {
		test("sets last used, and not again within a minute", async () => {
			const user = await instructor();
			const r = await made(user);
			await touchApiKey(t.db, r.key.id);
			const first = (await listApiKeys(t.db, user))[0]?.lastUsedAt;
			expect(first).not.toBeNull();
			await touchApiKey(t.db, r.key.id);
			expect((await listApiKeys(t.db, user))[0]?.lastUsedAt).toBe(first);
			await t.db
				.updateTable("api_keys")
				.set({ last_used_at: new Date(Date.now() - 120_000) })
				.execute();
			await touchApiKey(t.db, r.key.id);
			expect((await listApiKeys(t.db, user))[0]?.lastUsedAt).not.toBe(first);
		});
	});
});
