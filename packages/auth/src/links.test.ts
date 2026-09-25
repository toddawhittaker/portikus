import type { Database } from "@portikus/db";
import {
	createTestDb,
	hasTestDb,
	insertTestLtiMembership,
	insertTestLtiUser,
	insertTestUser,
	type TestDb,
} from "@portikus/db/testing";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import {
	bindLinkIntent,
	consumeLinkIntent,
	courseLinkWindow,
	findLinkIntent,
	grantAdministrator,
	grantInstructor,
	linkAccounts,
	listLinks,
	pendingLinkIntent,
	resolveIdentity,
	revokeAdministrator,
	revokeInstructor,
	saveLinkIntent,
	unlinkAccount,
} from "./links.js";
import { createSession, hashSessionToken, loadSession } from "./sessions.js";

const LMS = "https://lms.test.invalid";
const MINUTE = 60_000;

describe.skipIf(!hasTestDb())("account links and the role grant", () => {
	let t: TestDb;
	let db: Kysely<Database>;

	beforeAll(async () => {
		t = await createTestDb();
		db = t.db;
	});

	afterAll(async () => {
		await t?.close();
	});

	beforeEach(async () => {
		await t.truncate();
	});

	async function sessionFor(userId: string) {
		const { token } = await createSession(db, userId, 3600, {
			method: "oidc",
			courseUserId: null,
		});
		return { token, id: hashSessionToken(token) };
	}

	async function workspaceFor(userId: string, archivedAt: string | null = null) {
		const row = await db
			.insertInto("workspaces")
			.values({
				owner_user_id: userId,
				label: `ws-${userId.slice(0, 8)}`,
				state: "running",
				desired_state: "running",
				archived_at: archivedAt,
			})
			.returning("id")
			.executeTakeFirstOrThrow();
		return row.id;
	}

	async function link(courseUserId: string, userId: string) {
		return db
			.transaction()
			.execute((trx) => linkAccounts(trx, { courseUserId, userId }));
	}

	describe("the link window", () => {
		test("a fresh course session is open for 15 minutes", async () => {
			const course = await insertTestLtiUser(db, LMS);
			const s = await sessionFor(course);
			const now = new Date();
			const w = await courseLinkWindow(db, s.id, now);
			expect(w?.courseUserId).toBe(course);
			expect(w?.open).toBe(true);
			const until = w?.linkUntil.getTime() ?? 0;
			expect(Math.abs(until - (now.getTime() + 15 * MINUTE))).toBeLessThan(5000);

			const late = await courseLinkWindow(
				db,
				s.id,
				new Date(now.getTime() + 16 * MINUTE),
			);
			expect(late?.open).toBe(false);
		});

		test("an SSO session and a linked course session have no window", async () => {
			const sso = await insertTestUser(db);
			const course = await insertTestLtiUser(db, LMS);
			expect(await courseLinkWindow(db, (await sessionFor(sso)).id)).toBeNull();
			const s = await sessionFor(course);
			await db
				.insertInto("account_links")
				.values({
					course_user_id: course,
					user_id: sso,
					platform_issuer: LMS,
					archived_at: null,
				})
				.execute();
			expect(await courseLinkWindow(db, s.id)).toBeNull();
			expect(await courseLinkWindow(db, "no-such-session")).toBeNull();
		});
	});

	describe("intents", () => {
		test("stores only the state's hash and one row per session", async () => {
			const course = await insertTestLtiUser(db, LMS);
			const s = await sessionFor(course);
			await saveLinkIntent(db, {
				state: "first",
				sessionId: s.id,
				courseUserId: course,
			});
			await saveLinkIntent(db, {
				state: "second",
				sessionId: s.id,
				courseUserId: course,
			});

			const rows = await db.selectFrom("account_link_intents").selectAll().execute();
			expect(rows).toHaveLength(1);
			expect(rows[0]?.state_hash).toMatch(/^[0-9a-f]{64}$/);
			expect(rows[0]?.state_hash).not.toBe("second");
			expect(await findLinkIntent(db, "first")).toBeNull();
			expect(await findLinkIntent(db, "second")).toMatchObject({
				sessionId: s.id,
				courseUserId: course,
				userId: null,
			});
		});

		test("a new start replaces a bound intent with an unbound one", async () => {
			const course = await insertTestLtiUser(db, LMS);
			const sso = await insertTestUser(db);
			const s = await sessionFor(course);
			await saveLinkIntent(db, {
				state: "first",
				sessionId: s.id,
				courseUserId: course,
			});
			await bindLinkIntent(db, { state: "first", sessionId: s.id, userId: sso });
			await saveLinkIntent(db, {
				state: "second",
				sessionId: s.id,
				courseUserId: course,
			});
			expect(await pendingLinkIntent(db, s.id)).toBeNull();
			expect((await findLinkIntent(db, "second"))?.userId).toBeNull();
		});

		test("saving clears expired rows of other sessions", async () => {
			const a = await insertTestLtiUser(db, LMS);
			const b = await insertTestLtiUser(db, LMS);
			const sa = await sessionFor(a);
			const sb = await sessionFor(b);
			await saveLinkIntent(
				db,
				{ state: "old", sessionId: sa.id, courseUserId: a },
				new Date(Date.now() - 11 * MINUTE),
			);
			await saveLinkIntent(db, { state: "new", sessionId: sb.id, courseUserId: b });
			expect(await findLinkIntent(db, "old")).toBeNull();
			expect(await findLinkIntent(db, "new")).not.toBeNull();
		});

		test("binds once, only for the session that made it", async () => {
			const course = await insertTestLtiUser(db, LMS);
			const sso = await insertTestUser(db);
			const s = await sessionFor(course);
			const other = await sessionFor(sso);
			await saveLinkIntent(db, { state: "st", sessionId: s.id, courseUserId: course });

			// No row matches: another session, or an unknown state, binds nothing.
			expect(
				await bindLinkIntent(db, { state: "st", sessionId: other.id, userId: sso }),
			).toBe("expired");
			expect(
				await bindLinkIntent(db, { state: "nope", sessionId: s.id, userId: sso }),
			).toBe("expired");
			expect(await pendingLinkIntent(db, s.id)).toBeNull();

			expect(
				await bindLinkIntent(db, { state: "st", sessionId: s.id, userId: sso }),
			).toBeNull();
			expect(
				await bindLinkIntent(db, { state: "st", sessionId: s.id, userId: sso }),
			).toBe("expired");
			expect(await pendingLinkIntent(db, s.id)).toEqual({
				courseUserId: course,
				userId: sso,
			});
			// Reading the pending intent does not use it up.
			expect(await pendingLinkIntent(db, s.id)).not.toBeNull();
		});

		test("an expired intent cannot be bound or consumed", async () => {
			const course = await insertTestLtiUser(db, LMS);
			const sso = await insertTestUser(db);
			const s = await sessionFor(course);
			await saveLinkIntent(db, { state: "st", sessionId: s.id, courseUserId: course });
			const late = new Date(Date.now() + 11 * MINUTE);
			expect(
				await bindLinkIntent(db, { state: "st", sessionId: s.id, userId: sso }, late),
			).toBe("expired");

			expect(
				await bindLinkIntent(db, { state: "st", sessionId: s.id, userId: sso }),
			).toBeNull();
			expect(await pendingLinkIntent(db, s.id, late)).toBeNull();
			expect(await consumeLinkIntent(db, s.id, late)).toBeNull();
		});

		test("consume is single use and needs a bound intent", async () => {
			const course = await insertTestLtiUser(db, LMS);
			const sso = await insertTestUser(db);
			const s = await sessionFor(course);
			await saveLinkIntent(db, { state: "st", sessionId: s.id, courseUserId: course });
			expect(await consumeLinkIntent(db, s.id)).toBeNull();

			await bindLinkIntent(db, { state: "st", sessionId: s.id, userId: sso });
			const [first, second] = await Promise.all([
				consumeLinkIntent(db, s.id),
				consumeLinkIntent(db, s.id),
			]);
			expect([first, second].filter((r) => r !== null)).toEqual([
				{ courseUserId: course, userId: sso },
			]);
			expect(await findLinkIntent(db, "st")).toBeNull();
		});
	});

	describe("linkAccounts", () => {
		test("retires the course account, archives its workspace and moves memberships", async () => {
			const sso = await insertTestUser(db);
			const course = await insertTestLtiUser(db, LMS);
			const workspace = await workspaceFor(course);
			const ssoWorkspace = await workspaceFor(sso);
			const s = await sessionFor(course);
			await db
				.insertInto("preview_sessions")
				.values({
					token_hash: "preview",
					user_id: course,
					session_id: s.id,
					workspace_id: workspace,
					port: 3000,
					preview_host: "p.example",
				})
				.execute();
			// Course 1: only the course account. Course 2: both, the course account launched later.
			const c1 = await insertTestLtiMembership(db, course, {
				contextId: "c1",
				role: "instructor",
			});
			await insertTestLtiMembership(db, sso, { contextId: "c2", role: "student" });
			await db
				.updateTable("lti_memberships")
				.set({ last_launch_at: new Date(Date.now() - 60 * MINUTE).toISOString() })
				.where("user_id", "=", sso)
				.execute();
			const c2 = await insertTestLtiMembership(db, course, {
				contextId: "c2",
				role: "instructor",
			});

			const result = await link(course, sso);
			expect(result).toEqual({
				ok: true,
				platformIssuer: LMS,
				archivedWorkspaceId: workspace,
			});

			expect(await db.selectFrom("account_links").selectAll().execute()).toMatchObject([
				{
					course_user_id: course,
					user_id: sso,
					platform_issuer: LMS,
					archived_at: expect.any(Date),
				},
			]);
			const ws = await db
				.selectFrom("workspaces")
				.select(["id", "archived_at", "desired_state"])
				.orderBy("id")
				.execute();
			expect(ws.find((w) => w.id === workspace)).toMatchObject({
				desired_state: "stopped",
			});
			expect(ws.find((w) => w.id === workspace)?.archived_at).toBeInstanceOf(Date);
			expect(ws.find((w) => w.id === ssoWorkspace)?.archived_at).toBeNull();

			const memberships = await db
				.selectFrom("lti_memberships")
				.select(["context_id", "user_id", "role"])
				.orderBy("context_id")
				.execute();
			expect(memberships).toEqual(
				expect.arrayContaining([
					{ context_id: c1, user_id: sso, role: "instructor" },
					{ context_id: c2, user_id: sso, role: "instructor" },
				]),
			);
			expect(memberships).toHaveLength(2);

			expect(
				await db
					.selectFrom("sessions")
					.where("user_id", "=", course)
					.selectAll()
					.execute(),
			).toEqual([]);
			const livePreviews = await db
				.selectFrom("preview_sessions")
				.select("token_hash")
				.where("revoked_at", "is", null)
				.execute();
			expect(livePreviews).toEqual([]);
			expect(await loadSession(db, s.token)).toBeNull();
			expect(await resolveIdentity(db, `lti:${LMS}`, await subjectOf(course))).toEqual({
				userId: sso,
				courseUserId: course,
			});
		});

		test("a membership the SSO account launched more recently keeps its role", async () => {
			const sso = await insertTestUser(db);
			const course = await insertTestLtiUser(db, LMS);
			const c = await insertTestLtiMembership(db, course, { role: "student" });
			await db
				.updateTable("lti_memberships")
				.set({ last_launch_at: new Date(Date.now() - 60 * MINUTE).toISOString() })
				.execute();
			await insertTestLtiMembership(db, sso, { role: "instructor" });
			await link(course, sso);
			expect(
				await db
					.selectFrom("lti_memberships")
					.select(["context_id", "user_id", "role"])
					.execute(),
			).toEqual([{ context_id: c, user_id: sso, role: "instructor" }]);
		});

		test("an already archived workspace is left as it was and not recorded", async () => {
			const sso = await insertTestUser(db);
			const course = await insertTestLtiUser(db, LMS);
			const archivedAt = "2026-01-01T00:00:00.000Z";
			await workspaceFor(course, archivedAt);
			const result = await link(course, sso);
			expect(result).toMatchObject({ ok: true, archivedWorkspaceId: null });
			const row = await db
				.selectFrom("account_links")
				.select("archived_at")
				.executeTakeFirstOrThrow();
			expect(row.archived_at).toBeNull();
			const ws = await db
				.selectFrom("workspaces")
				.select("archived_at")
				.executeTakeFirstOrThrow();
			expect(ws.archived_at?.toISOString()).toBe(archivedAt);
		});

		test("one course identity per platform per SSO account", async () => {
			const sso = await insertTestUser(db);
			const first = await insertTestLtiUser(db, LMS);
			const second = await insertTestLtiUser(db, LMS);
			const elsewhere = await insertTestLtiUser(db, "https://other.lms");
			expect((await link(first, sso)).ok).toBe(true);
			expect(await link(second, sso)).toEqual({ ok: false, reason: "already_linked" });
			expect((await link(elsewhere, sso)).ok).toBe(true);
		});

		test("two SSO accounts cannot claim one course identity", async () => {
			const alice = await insertTestUser(db);
			const bob = await insertTestUser(db);
			const course = await insertTestLtiUser(db, LMS);
			const results = await Promise.all([link(course, alice), link(course, bob)]);
			expect(results.filter((r) => r.ok)).toHaveLength(1);
			expect(results.filter((r) => !r.ok)).toEqual([
				{ ok: false, reason: "already_linked" },
			]);
			expect(await db.selectFrom("account_links").selectAll().execute()).toHaveLength(
				1,
			);
		});

		test("links only a course account to an SSO account", async () => {
			const sso = await insertTestUser(db);
			const otherSso = await insertTestUser(db);
			const course = await insertTestLtiUser(db, LMS);
			const otherCourse = await insertTestLtiUser(db, "https://other.lms");
			expect(await link(otherSso, sso)).toEqual({
				ok: false,
				reason: "not_course_account",
			});
			expect(await link(course, otherCourse)).toEqual({
				ok: false,
				reason: "not_sso_account",
			});
			expect(await link(course, course)).toEqual({ ok: false, reason: "not_found" });
			expect(await link(course, "00000000-0000-0000-0000-000000000000")).toEqual({
				ok: false,
				reason: "not_found",
			});
			expect(await db.selectFrom("account_links").selectAll().execute()).toEqual([]);
		});

		test("refuses a disabled SSO account", async () => {
			const sso = await insertTestUser(db, { disabled_at: new Date().toISOString() });
			const course = await insertTestLtiUser(db, LMS);
			expect(await link(course, sso)).toEqual({ ok: false, reason: "not_authorized" });
			expect(await db.selectFrom("account_links").selectAll().execute()).toEqual([]);
		});
	});

	describe("unlinkAccount", () => {
		test("only the owning SSO account can unlink, and the workspace comes back stopped", async () => {
			const sso = await insertTestUser(db);
			const stranger = await insertTestUser(db);
			const course = await insertTestLtiUser(db, LMS);
			const workspace = await workspaceFor(course);
			await link(course, sso);

			const unlink = (userId: string) =>
				db
					.transaction()
					.execute((trx) => unlinkAccount(trx, { userId, courseUserId: course }));
			expect(await unlink(stranger)).toBeNull();
			expect(await unlink(sso)).toEqual({
				platformIssuer: LMS,
				unarchivedWorkspaceId: workspace,
			});
			expect(await unlink(sso)).toBeNull();

			const ws = await db
				.selectFrom("workspaces")
				.select(["archived_at", "desired_state"])
				.executeTakeFirstOrThrow();
			expect(ws).toEqual({ archived_at: null, desired_state: "stopped" });
			expect(await resolveIdentity(db, `lti:${LMS}`, await subjectOf(course))).toEqual({
				userId: course,
				courseUserId: null,
			});
			const s = await sessionFor(course);
			expect((await loadSession(db, s.token))?.id).toBe(course);
		});

		test("a workspace archived before the link stays archived", async () => {
			const sso = await insertTestUser(db);
			const course = await insertTestLtiUser(db, LMS);
			await workspaceFor(course, "2026-01-01T00:00:00.000Z");
			await link(course, sso);
			const result = await db
				.transaction()
				.execute((trx) => unlinkAccount(trx, { userId: sso, courseUserId: course }));
			expect(result).toEqual({ platformIssuer: LMS, unarchivedWorkspaceId: null });
			const ws = await db
				.selectFrom("workspaces")
				.select("archived_at")
				.executeTakeFirstOrThrow();
			expect(ws.archived_at).not.toBeNull();
		});

		test("a workspace archived again after the link keeps the later archive", async () => {
			const sso = await insertTestUser(db);
			const course = await insertTestLtiUser(db, LMS);
			await workspaceFor(course);
			await link(course, sso);
			// An administrator unarchives and archives again while the link stands.
			const later = "2030-01-01T00:00:00.000Z";
			await db.updateTable("workspaces").set({ archived_at: later }).execute();
			const result = await db
				.transaction()
				.execute((trx) => unlinkAccount(trx, { userId: sso, courseUserId: course }));
			expect(result).toEqual({ platformIssuer: LMS, unarchivedWorkspaceId: null });
			const ws = await db
				.selectFrom("workspaces")
				.select("archived_at")
				.executeTakeFirstOrThrow();
			expect(ws.archived_at?.toISOString()).toBe(later);
		});
	});

	test("resolveIdentity and listLinks", async () => {
		const sso = await insertTestUser(db, { oidc_subject: "sso-sub" });
		const course = await insertTestLtiUser(db, LMS, {
			oidc_subject: "course-sub",
			display_name: "Sam Student",
		});
		expect(await resolveIdentity(db, "https://test.invalid", "sso-sub")).toEqual({
			userId: sso,
			courseUserId: null,
		});
		expect(await resolveIdentity(db, "https://test.invalid", "missing")).toBeNull();
		expect(await resolveIdentity(db, `lti:${LMS}`, "course-sub")).toEqual({
			userId: course,
			courseUserId: null,
		});
		expect(await listLinks(db, sso)).toEqual([]);

		await link(course, sso);
		expect(await resolveIdentity(db, `lti:${LMS}`, "course-sub")).toEqual({
			userId: sso,
			courseUserId: course,
		});
		const links = await listLinks(db, sso);
		expect(links).toEqual([
			{
				courseUserId: course,
				platformIssuer: LMS,
				displayName: "Sam Student",
				linkedAt: expect.any(Date),
			},
		]);
	});

	describe("grant and revoke administrator", () => {
		const grant = (id: string) =>
			db.transaction().execute((trx) => grantAdministrator(trx, id));
		const revoke = (actorId: string, targetId: string) =>
			db
				.transaction()
				.execute((trx) => revokeAdministrator(trx, { actorId, targetId }));

		async function roleRow(id: string) {
			return db
				.selectFrom("users")
				.select(["role", "provider_role", "granted_role"])
				.where("id", "=", id)
				.executeTakeFirstOrThrow();
		}

		test("promotes an SSO account and demote restores the provider's role", async () => {
			const admin = await insertTestUser(db, { role: "administrator" });
			const target = await insertTestUser(db, { role: "instructor" });
			expect(await grant(target)).toEqual({
				ok: true,
				changed: true,
				from: "instructor",
				to: "administrator",
			});
			expect(await roleRow(target)).toEqual({
				role: "administrator",
				provider_role: "instructor",
				granted_role: "administrator",
			});
			expect(await revoke(admin, target)).toEqual({
				ok: true,
				from: "administrator",
				to: "instructor",
			});
			expect(await roleRow(target)).toEqual({
				role: "instructor",
				provider_role: "instructor",
				granted_role: null,
			});
		});

		test("promote is a no-op for an administrator and refused for a course account", async () => {
			const admin = await insertTestUser(db, { role: "administrator" });
			const course = await insertTestLtiUser(db, LMS);
			expect(await grant(admin)).toEqual({
				ok: true,
				changed: false,
				from: "administrator",
				to: "administrator",
			});
			expect(await roleRow(admin)).toMatchObject({ granted_role: null });
			expect(await grant(course)).toEqual({ ok: false, reason: "course_account" });
			expect(await grant("00000000-0000-0000-0000-000000000000")).toEqual({
				ok: false,
				reason: "not_found",
			});
		});

		test("demote refuses oneself, a provider administrator, and the last administrator", async () => {
			const provider = await insertTestUser(db, { role: "administrator" });
			const granted = await insertTestUser(db, { role: "student" });
			await grant(granted);
			expect(await revoke(granted, granted)).toEqual({ ok: false, reason: "self" });
			expect(await revoke(granted, provider)).toEqual({
				ok: false,
				reason: "provider_administrator",
			});
			const student = await insertTestUser(db, { role: "student" });
			expect(await revoke(granted, student)).toEqual({
				ok: false,
				reason: "not_administrator",
			});

			// Disable the provider administrator: the granted one is now the last enabled one.
			await db
				.updateTable("users")
				.set({ disabled_at: new Date().toISOString() })
				.where("id", "=", provider)
				.execute();
			expect(await revoke(provider, granted)).toEqual({
				ok: false,
				reason: "last_administrator",
			});
			expect(await roleRow(granted)).toMatchObject({ role: "administrator" });
		});

		test("two administrators demoting each other at once leave one administrator", async () => {
			const a = await insertTestUser(db);
			const b = await insertTestUser(db);
			await grant(a);
			await grant(b);
			const results = await Promise.all([revoke(a, b), revoke(b, a)]);
			expect(results.filter((r) => r.ok)).toHaveLength(1);
			expect(results.filter((r) => !r.ok)).toEqual([
				{ ok: false, reason: "last_administrator" },
			]);
			const admins = await db
				.selectFrom("users")
				.select("id")
				.where("role", "=", "administrator")
				.execute();
			expect(admins).toHaveLength(1);
		});
	});

	describe("grant and revoke instructor", () => {
		const grant = (id: string) =>
			db.transaction().execute((trx) => grantInstructor(trx, id));
		const revoke = (id: string) =>
			db.transaction().execute((trx) => revokeInstructor(trx, id));

		async function roleRow(id: string) {
			return db
				.selectFrom("users")
				.select(["role", "provider_role", "granted_role"])
				.where("id", "=", id)
				.executeTakeFirstOrThrow();
		}

		test("makes a student an instructor and removal restores the provider's role", async () => {
			const target = await insertTestUser(db, { role: "student" });
			expect(await grant(target)).toEqual({
				ok: true,
				changed: true,
				from: "student",
				to: "instructor",
			});
			expect(await roleRow(target)).toEqual({
				role: "instructor",
				provider_role: "student",
				granted_role: "instructor",
			});
			expect(await revoke(target)).toEqual({
				ok: true,
				from: "instructor",
				to: "student",
			});
			expect(await roleRow(target)).toEqual({
				role: "student",
				provider_role: "student",
				granted_role: null,
			});
		});

		test("is a no-op for a provider instructor or administrator", async () => {
			for (const role of ["instructor", "administrator"] as const) {
				const target = await insertTestUser(db, { role });
				expect(await grant(target)).toEqual({
					ok: true,
					changed: false,
					from: role,
					to: role,
				});
				expect(await roleRow(target)).toMatchObject({ granted_role: null });
			}
		});

		test("refuses a course account and never touches an administrator grant", async () => {
			const course = await insertTestLtiUser(db, LMS);
			expect(await grant(course)).toEqual({ ok: false, reason: "course_account" });
			const admin = await insertTestUser(db, { role: "student" });
			await db.transaction().execute((trx) => grantAdministrator(trx, admin));
			expect(await grant(admin)).toEqual({
				ok: false,
				reason: "granted_administrator",
			});
			expect(await revoke(admin)).toEqual({ ok: false, reason: "not_granted" });
			expect(await roleRow(admin)).toMatchObject({
				role: "administrator",
				granted_role: "administrator",
			});
			expect(await grant("00000000-0000-0000-0000-000000000000")).toEqual({
				ok: false,
				reason: "not_found",
			});
			expect(await revoke("00000000-0000-0000-0000-000000000000")).toEqual({
				ok: false,
				reason: "not_found",
			});
		});

		test("remove refuses an account without an instructor grant", async () => {
			const provider = await insertTestUser(db, { role: "instructor" });
			expect(await revoke(provider)).toEqual({ ok: false, reason: "not_granted" });
			expect(await roleRow(provider)).toMatchObject({ role: "instructor" });
		});
	});

	async function subjectOf(id: string) {
		const row = await db
			.selectFrom("users")
			.select("oidc_subject")
			.where("id", "=", id)
			.executeTakeFirstOrThrow();
		return row.oidc_subject;
	}
});
