import { createSession, hashSessionToken } from "@portikus/auth";
import {
	createTestDb,
	hasTestDb,
	insertTestLtiUser,
	insertTestUser,
	type TestDb,
} from "@portikus/db/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import {
	createPreviewLookupCache,
	createPreviewSession,
	loadMainSessionUser,
	PREVIEW_LOOKUP_TTL_MS,
} from "./store.js";

const skip = !hasTestDb();
let testDb: TestDb;

beforeAll(async () => {
	if (skip) return;
	testDb = await createTestDb();
});

afterAll(async () => {
	if (!skip) await testDb.close();
});

beforeEach(async () => {
	if (!skip) await testDb.truncate();
});

async function sessionId(
	userId: string,
	method: "oidc" | "lti",
	courseUserId: string | null = null,
): Promise<string> {
	const { token } = await createSession(testDb.db, userId, 600, {
		method,
		courseUserId,
	});
	return hashSessionToken(token);
}

// The preview gateway applies the same rules as loadSession (review N5).
describe.skipIf(skip)("loadMainSessionUser", () => {
	test("returns the user of a live session", async () => {
		const user = await insertTestUser(testDb.db);
		expect(
			(await loadMainSessionUser(testDb.db, await sessionId(user, "oidc")))?.id,
		).toBe(user);
	});

	test("refuses a launch session whose account is an administrator", async () => {
		const admin = await insertTestUser(testDb.db, { role: "administrator" });
		const course = await insertTestLtiUser(testDb.db);
		const id = await sessionId(admin, "lti", course);
		expect(await loadMainSessionUser(testDb.db, id)).toBeNull();
	});

	test("refuses a course account retired by a link", async () => {
		const sso = await insertTestUser(testDb.db);
		const course = await insertTestLtiUser(testDb.db);
		const id = await sessionId(course, "lti");
		await testDb.db
			.insertInto("account_links")
			.values({
				course_user_id: course,
				user_id: sso,
				platform_issuer: "https://lms.test.invalid",
				archived_at: null,
			})
			.execute();
		expect(await loadMainSessionUser(testDb.db, id)).toBeNull();
	});
});

// ── The authorize lookup cache (docs/EPIC-17.md rulings 10 and 11) ──

describe.skipIf(skip)("createPreviewLookupCache", () => {
	async function world() {
		const user = await insertTestUser(testDb.db);
		const { token: mainToken } = await createSession(testDb.db, user, 600, {
			method: "oidc",
			courseUserId: null,
		});
		const workspace = await testDb.db
			.insertInto("workspaces")
			.values({
				owner_user_id: user,
				label: `cache-${Math.random().toString(16).slice(2, 8)}`,
				state: "running",
			})
			.returning("id")
			.executeTakeFirstOrThrow();
		const token = await createPreviewSession(testDb.db, {
			userId: user,
			sessionId: hashSessionToken(mainToken),
			workspaceId: workspace.id,
			port: 5173,
			previewHost: "x-5173.preview.localhost",
		});
		return { user, mainToken, workspaceId: workspace.id, token };
	}

	/** The test database, counting every query it runs. */
	function countingDb() {
		let queries = 0;
		const db = testDb.db.withPlugin({
			transformQuery(args) {
				queries += 1;
				return args.node;
			},
			async transformResult(args) {
				return args.result;
			},
		});
		return { db, count: () => queries };
	}

	test("returns all three rows and serves repeats from memory for two seconds", async () => {
		const { user, workspaceId, token } = await world();
		const { db, count } = countingDb();
		let clock = 0;
		const cache = createPreviewLookupCache(db, () => clock);
		const first = await cache.get(token);
		expect(first.session?.user_id).toBe(user);
		expect(first.user?.id).toBe(user);
		expect(first.workspace?.id).toBe(workspaceId);
		const perLookup = count();
		expect(perLookup).toBeLessThanOrEqual(4);

		// Each asset of a big page is one authorize request.
		for (let i = 0; i < 199; i++) await cache.get(token);
		clock += PREVIEW_LOOKUP_TTL_MS - 1;
		await cache.get(token);
		expect(count()).toBe(perLookup);
	});

	test("after the window a stop and a sign-out are seen", async () => {
		const { workspaceId, mainToken, token } = await world();
		let clock = 0;
		const cache = createPreviewLookupCache(testDb.db, () => clock);
		expect((await cache.get(token)).workspace?.state).toBe("running");

		await testDb.db
			.updateTable("workspaces")
			.set({ state: "stopped" })
			.where("id", "=", workspaceId)
			.execute();
		clock += PREVIEW_LOOKUP_TTL_MS;
		expect((await cache.get(token)).workspace?.state).toBe("stopped");

		await testDb.db
			.deleteFrom("sessions")
			.where("id", "=", hashSessionToken(mainToken))
			.execute();
		clock += PREVIEW_LOOKUP_TTL_MS;
		expect((await cache.get(token)).user).toBeNull();
	});

	test("keeps nothing for an unknown or revoked cookie", async () => {
		const { token } = await world();
		const cache = createPreviewLookupCache(testDb.db);
		expect((await cache.get("made-up")).session).toBeNull();
		expect(cache.size).toBe(0);
		await testDb.db
			.updateTable("preview_sessions")
			.set({ revoked_at: new Date().toISOString() })
			.execute();
		expect((await cache.get(token)).session).toBeNull();
		expect(cache.size).toBe(0);
	});

	test("is keyed by the cookie: another cookie gets its own rows", async () => {
		const a = await world();
		const b = await world();
		const cache = createPreviewLookupCache(testDb.db);
		expect((await cache.get(a.token)).user?.id).toBe(a.user);
		expect((await cache.get(b.token)).user?.id).toBe(b.user);
		expect((await cache.get(a.token)).user?.id).toBe(a.user);
		expect(cache.size).toBe(2);
		cache.clear();
		expect(cache.size).toBe(0);
	});

	test("drops expired entries as it adds new ones", async () => {
		const a = await world();
		const b = await world();
		let clock = 0;
		const cache = createPreviewLookupCache(testDb.db, () => clock);
		await cache.get(a.token);
		clock += PREVIEW_LOOKUP_TTL_MS;
		await cache.get(b.token);
		expect(cache.size).toBe(1);
	});
});
