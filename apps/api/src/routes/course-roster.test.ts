import { generateKeyPairSync } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createOidcClient, createSession, type LtiPlatform } from "@portikus/auth";
import { CourseMembersResponse, RosterSyncResponse } from "@portikus/contracts";
import {
	createTestDb,
	hasTestDb,
	insertTestLtiMembership,
	insertTestLtiUser,
	insertTestUser,
	type TestDb,
} from "@portikus/db/testing";
import { collectingLogger } from "@portikus/observability/testing";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { toAuthOptions } from "../auth-options.js";
import { UNNAMED_MEMBER } from "../courses/roster.js";
import { buildServer } from "../server.js";
import { PUBLIC_URL, testConfig } from "../testing/test-support.js";

/**
 * Roster sync against a real database and a local stand-in for the LMS's
 * token and memberships endpoints (ADR 0058, SPEC.md section 24.11).
 */

const skip = !hasTestDb();
const ISSUER = "https://lms.test.invalid";
const CLIENT_ID = "client-1";
const ACCESS_TOKEN = "lms-access-token-7f3a";
const LEARNER = "http://purl.imsglobal.org/vocab/lis/v2/membership#Learner";
const INSTRUCTOR = "http://purl.imsglobal.org/vocab/lis/v2/membership#Instructor";

const toolKeyPem = generateKeyPairSync("rsa", { modulusLength: 2048 })
	.privateKey.export({ type: "pkcs8", format: "pem" })
	.toString();

interface RosterEntry {
	user_id: string;
	name?: string;
	roles: string[];
	status?: "Active" | "Inactive" | "Deleted";
}

/** What the stand-in LMS answers; each test sets it. */
const lms = {
	tokenStatus: 200,
	membersStatus: 200,
	membersBody: undefined as unknown,
	members: [] as RosterEntry[],
	delayMs: 0,
	tokenHits: 0,
	memberHits: 0,
	badBearer: 0,
};

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
	req.resume();
	req.on("end", () => {
		if (req.method === "POST" && req.url === "/token") {
			lms.tokenHits += 1;
			res.writeHead(lms.tokenStatus, { "content-type": "application/json" });
			res.end(JSON.stringify({ access_token: ACCESS_TOKEN }));
			return;
		}
		if (req.method === "GET" && req.url === "/members") {
			lms.memberHits += 1;
			if (req.headers.authorization !== `Bearer ${ACCESS_TOKEN}`) lms.badBearer += 1;
			setTimeout(() => {
				res.writeHead(lms.membersStatus, { "content-type": "application/json" });
				res.end(JSON.stringify(lms.membersBody ?? { members: lms.members }));
			}, lms.delayMs);
			return;
		}
		res.writeHead(404).end();
	});
});

let lmsUrl: string;
let testDb: TestDb;
let app: FastifyInstance;
let lines: Record<string, unknown>[];

function platform(withTokenUrl: boolean): LtiPlatform {
	return {
		name: "Test LMS",
		issuer: ISSUER,
		clientId: CLIENT_ID,
		authLoginUrl: `${ISSUER}/authorize`,
		keysetUrl: `${lmsUrl}/jwks`,
		...(withTokenUrl ? { authTokenUrl: `${lmsUrl}/token` } : {}),
		deploymentIds: ["dep-1"],
		mock: true,
	};
}

async function build(withTokenUrl = true): Promise<FastifyInstance> {
	const config = testConfig("http://127.0.0.1:1/unused");
	const collected = collectingLogger("debug");
	lines = collected.lines;
	const built = buildServer({
		db: testDb.db,
		config,
		logger: collected.logger,
		oidc: createOidcClient(toAuthOptions(config)),
		lti: { platforms: [platform(withTokenUrl)], toolKeyPem },
	});
	await built.ready();
	return built;
}

beforeAll(async () => {
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	lmsUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	if (skip) return;
	testDb = await createTestDb();
});

afterAll(async () => {
	server.closeAllConnections();
	await new Promise((resolve) => server.close(resolve));
	if (skip) return;
	await testDb.close();
});

beforeEach(async () => {
	if (skip) return;
	Object.assign(lms, {
		tokenStatus: 200,
		membersStatus: 200,
		membersBody: undefined,
		members: [],
		delayMs: 0,
		tokenHits: 0,
		memberHits: 0,
		badBearer: 0,
	});
	await testDb.truncate();
	app = await build();
	return () => app.close();
});

async function cookieFor(userId: string): Promise<string> {
	const session = await createSession(testDb.db, userId, 3600, {
		method: "oidc",
		courseUserId: null,
	});
	return `portikus_session=${session.token}`;
}

function sync(courseId: string, cookie: string) {
	return app.inject({
		method: "POST",
		url: `/courses/${courseId}/roster/sync`,
		headers: { cookie, origin: PUBLIC_URL },
	});
}

function members(courseId: string, cookie: string) {
	return app.inject({ url: `/courses/${courseId}/members`, headers: { cookie } });
}

async function memberships(courseId: string): Promise<Record<string, string>> {
	const rows = await testDb.db
		.selectFrom("lti_memberships")
		.select(["user_id", "role"])
		.where("context_id", "=", courseId)
		.execute();
	return Object.fromEntries(rows.map((row) => [row.user_id, row.role]));
}

async function courseRow(courseId: string) {
	return testDb.db
		.selectFrom("lti_contexts")
		.select(["roster_synced_at", "roster_sync_result"])
		.where("id", "=", courseId)
		.executeTakeFirstOrThrow();
}

async function audits(action: string) {
	return testDb.db
		.selectFrom("audit_events")
		.selectAll()
		.where("action", "=", action)
		.orderBy("id")
		.execute();
}

/**
 * Ivy and Tom teach CS 101, where Sam and Lee are students; Sam has a
 * running workspace. The course has the client id and memberships URL a
 * launch stores.
 */
async function seed() {
	const user = (
		subject: string,
		displayName: string,
		role: "student" | "instructor" = "student",
	) =>
		insertTestLtiUser(testDb.db, ISSUER, {
			oidc_subject: subject,
			display_name: displayName,
			role,
		});
	const ivy = await user("sub-ivy", "Ivy Instructor", "instructor");
	const tom = await user("sub-tom", "Tom Assistant", "instructor");
	const sam = await user("sub-sam", "Sam Student");
	const lee = await user("sub-lee", "Lee Learner");
	const cs101 = await insertTestLtiMembership(testDb.db, ivy, {
		issuer: ISSUER,
		contextId: "cs101",
		title: "CS 101",
		role: "instructor",
	});
	await insertTestLtiMembership(testDb.db, tom, {
		issuer: ISSUER,
		contextId: "cs101",
		role: "instructor",
	});
	for (const student of [sam, lee]) {
		await insertTestLtiMembership(testDb.db, student, {
			issuer: ISSUER,
			contextId: "cs101",
		});
	}
	await testDb.db
		.updateTable("lti_contexts")
		.set({ platform_client_id: CLIENT_ID, nrps_url: `${lmsUrl}/members` })
		.where("id", "=", cs101)
		.execute();
	await testDb.db
		.insertInto("workspaces")
		.values({
			owner_user_id: sam,
			incus_instance_name: "ws-sam",
			label: "sam-label",
			state: "running",
			desired_state: "running",
			quota_config: JSON.stringify({}),
		})
		.execute();
	return { ivy, tom, sam, lee, cs101 };
}

const ivyEntry: RosterEntry = {
	user_id: "sub-ivy",
	name: "Ivy Instructor",
	roles: [INSTRUCTOR],
};

test.skipIf(skip)(
	"a sync adds not-started people, removes those gone (instructors too) and changes only course roles",
	async () => {
		const { ivy, tom, sam, lee, cs101 } = await seed();
		lms.members = [
			ivyEntry,
			// Sam becomes a teaching assistant in the LMS.
			{ user_id: "sub-sam", name: "Sam Student", roles: [INSTRUCTOR] },
			// Lee left: still listed, but inactive.
			{ user_id: "sub-lee", name: "Lee Learner", roles: [LEARNER], status: "Inactive" },
			{ user_id: "sub-rosa", name: "Rosa Roster", roles: [LEARNER] },
			{ user_id: "sub-ned", roles: [LEARNER], status: "Active" },
			{ user_id: "sub-gone", name: "Gina Gone", roles: [LEARNER], status: "Deleted" },
		];
		const res = await sync(cs101, await cookieFor(ivy));
		expect(res.statusCode).toBe(200);
		const body = RosterSyncResponse.parse(res.json());
		expect(body).toMatchObject({
			matched: 2,
			notStarted: 2,
			removed: 2,
			roleChanged: 1,
		});
		expect(body.roster).toMatchObject({ available: true, result: "ok" });
		expect(body.roster.syncedAt).not.toBeNull();
		expect(lms.badBearer).toBe(0);

		// Tom, an instructor not on the roster, and inactive Lee are gone.
		expect(await memberships(cs101)).toEqual({
			[ivy]: "instructor",
			[sam]: "instructor",
		});
		const removed = await audits("course.member_removed");
		expect(removed.map((row) => row.target).sort()).toEqual([tom, lee].sort());
		for (const row of removed) {
			expect(row.actor).toBe(`user:${ivy}`);
			expect(row.metadata).toEqual({ contextId: cs101, source: "roster" });
		}

		// Accounts, account roles and workspaces stay as they were (ADR 0025).
		const users = await testDb.db
			.selectFrom("users")
			.select(["id", "role", "disabled_at"])
			.where("id", "in", [tom, sam, lee])
			.execute();
		expect(users).toHaveLength(3);
		expect(users.find((row) => row.id === sam)?.role).toBe("student");
		expect(users.every((row) => row.disabled_at === null)).toBe(true);
		const ws = await testDb.db
			.selectFrom("workspaces")
			.select("state")
			.where("owner_user_id", "=", sam)
			.executeTakeFirstOrThrow();
		expect(ws.state).toBe("running");

		const page = CourseMembersResponse.parse(
			(await members(cs101, await cookieFor(ivy))).json(),
		);
		expect(page.roster).toMatchObject({ available: true, result: "ok" });
		expect(page.members.map((m) => [m.status, m.role, m.displayName])).toEqual([
			["active", "instructor", "Ivy Instructor"],
			["active", "instructor", "Sam Student"],
			["not_started", "student", UNNAMED_MEMBER],
			["not_started", "student", "Rosa Roster"],
		]);
		const notStarted = page.members.find((m) => m.displayName === "Rosa Roster");
		expect(notStarted).toEqual({
			status: "not_started",
			userId: null,
			displayName: "Rosa Roster",
			role: "student",
			lastLaunchAt: null,
			workspaceState: null,
		});
		const rows = await testDb.db
			.selectFrom("lti_roster_members")
			.selectAll()
			.where("context_id", "=", cs101)
			.execute();
		expect(rows.map((row) => row.subject).sort()).toEqual(["sub-ned", "sub-rosa"]);
	},
);

test.skipIf(skip)("each sync replaces the not-started rows", async () => {
	const { ivy, cs101 } = await seed();
	const cookie = await cookieFor(ivy);
	lms.members = [
		ivyEntry,
		{ user_id: "sub-rosa", name: "Rosa Roster", roles: [LEARNER] },
	];
	await sync(cs101, cookie);
	lms.members = [
		ivyEntry,
		{ user_id: "sub-drew", name: "Drew Dropped", roles: [LEARNER] },
	];
	const body = RosterSyncResponse.parse((await sync(cs101, cookie)).json());
	expect(body.notStarted).toBe(1);
	const rows = await testDb.db
		.selectFrom("lti_roster_members")
		.select("subject")
		.where("context_id", "=", cs101)
		.execute();
	expect(rows.map((row) => row.subject)).toEqual(["sub-drew"]);
});

test.skipIf(skip)(
	"a not-started person who launches since the sync is listed once, as a member",
	async () => {
		const { ivy, cs101 } = await seed();
		const cookie = await cookieFor(ivy);
		lms.members = [
			ivyEntry,
			{ user_id: "sub-rosa", name: "Rosa Roster", roles: [LEARNER] },
		];
		await sync(cs101, cookie);
		const rosa = await insertTestLtiUser(testDb.db, ISSUER, {
			oidc_subject: "sub-rosa",
			display_name: "Rosa Roster",
		});
		await insertTestLtiMembership(testDb.db, rosa, {
			issuer: ISSUER,
			contextId: "cs101",
		});
		const page = CourseMembersResponse.parse((await members(cs101, cookie)).json());
		const rosas = page.members.filter((m) => m.displayName === "Rosa Roster");
		expect(rosas.map((m) => m.status)).toEqual(["active"]);
	},
);

test.skipIf(skip)(
	"a membership held by a linked SSO account matches its course identity's subject",
	async () => {
		const { ivy, sam, cs101 } = await seed();
		// Sam's course account is linked to an SSO account, which now holds the membership.
		const sso = await insertTestUser(testDb.db, {
			oidc_issuer: "https://sso.test.invalid",
			oidc_subject: "sub-sam",
			display_name: "Sam SSO",
		});
		await testDb.db
			.insertInto("account_links")
			.values({
				course_user_id: sam,
				user_id: sso,
				platform_issuer: ISSUER,
				archived_at: null,
			})
			.execute();
		await insertTestLtiMembership(testDb.db, sso, {
			issuer: ISSUER,
			contextId: "cs101",
		});
		// An SSO subject equal to a roster subject is not an LTI identity.
		const stranger = await insertTestUser(testDb.db, {
			oidc_issuer: "https://sso.test.invalid",
			oidc_subject: "sub-rosa",
		});
		await insertTestLtiMembership(testDb.db, stranger, {
			issuer: ISSUER,
			contextId: "cs101",
		});

		lms.members = [
			ivyEntry,
			{ user_id: "sub-sam", name: "Sam Student", roles: [LEARNER] },
			{ user_id: "sub-rosa", name: "Rosa Roster", roles: [LEARNER] },
		];
		const body = RosterSyncResponse.parse(
			(await sync(cs101, await cookieFor(ivy))).json(),
		);
		expect(body).toMatchObject({ notStarted: 1, roleChanged: 0 });
		const kept = await memberships(cs101);
		expect(kept[sso]).toBe("student");
		expect(kept[sam]).toBe("student");
		expect(kept[stranger]).toBeUndefined();
		const page = CourseMembersResponse.parse(
			(await members(cs101, await cookieFor(ivy))).json(),
		);
		expect(page.members.filter((m) => m.status === "not_started")).toHaveLength(1);
	},
);

/** A sync that must change nothing but the recorded result. */
async function expectNothingApplied(result: string, setUp: () => void) {
	const { ivy, tom, sam, lee, cs101 } = await seed();
	await testDb.db
		.insertInto("lti_roster_members")
		.values({
			context_id: cs101,
			subject: "sub-old",
			display_name: "Old Row",
			role: "student",
		})
		.execute();
	setUp();
	const res = await sync(cs101, await cookieFor(ivy));
	expect(res.statusCode).toBe(200);
	const body = RosterSyncResponse.parse(res.json());
	expect(body).toMatchObject({ matched: 0, notStarted: 0, removed: 0, roleChanged: 0 });
	expect(body.roster).toMatchObject({ available: true, result });
	expect(await memberships(cs101)).toEqual({
		[ivy]: "instructor",
		[tom]: "instructor",
		[sam]: "student",
		[lee]: "student",
	});
	const roster = await testDb.db
		.selectFrom("lti_roster_members")
		.select("subject")
		.where("context_id", "=", cs101)
		.execute();
	expect(roster).toEqual([{ subject: "sub-old" }]);
	expect((await courseRow(cs101)).roster_sync_result).toBe(result);
	expect(await audits("course.member_removed")).toEqual([]);
	const synced = await audits("course.roster_synced");
	expect(synced).toHaveLength(1);
	expect(synced[0]?.result).toBe("failed");
	expect(synced[0]?.metadata).toMatchObject({ result });
}

test.skipIf(skip)("an empty roster applies nothing", () =>
	expectNothingApplied("empty", () => {
		lms.members = [];
	}),
);

test.skipIf(skip)("a roster with no active member applies nothing", () =>
	expectNothingApplied("empty", () => {
		lms.members = [{ ...ivyEntry, status: "Inactive" }];
	}),
);

test.skipIf(skip)("a refused token request applies nothing", () =>
	expectNothingApplied("token_failed", () => {
		lms.tokenStatus = 401;
	}),
);

test.skipIf(skip)("a failed memberships fetch applies nothing", () =>
	expectNothingApplied("fetch_failed", () => {
		lms.membersStatus = 500;
	}),
);

test.skipIf(skip)("a memberships page of the wrong shape applies nothing", () =>
	expectNothingApplied("invalid", () => {
		lms.membersBody = { members: "everyone" };
	}),
);

test.skipIf(skip)(
	"a platform without a token URL offers no sync and calls nothing",
	async () => {
		await app.close();
		app = await build(false);
		const { ivy, cs101 } = await seed();
		const cookie = await cookieFor(ivy);
		const res = await sync(cs101, cookie);
		expect(res.statusCode).toBe(200);
		expect(RosterSyncResponse.parse(res.json())).toEqual({
			roster: { available: false, syncedAt: null, result: null },
			matched: 0,
			notStarted: 0,
			removed: 0,
			roleChanged: 0,
		});
		const page = CourseMembersResponse.parse((await members(cs101, cookie)).json());
		expect(page.roster).toEqual({ available: false, syncedAt: null, result: null });
		expect(page.members).toHaveLength(4);
		expect(lms.tokenHits + lms.memberHits).toBe(0);
		expect(await audits("course.roster_synced")).toEqual([]);
	},
);

test.skipIf(skip)(
	"a course no launch has given a memberships URL offers no sync",
	async () => {
		const { ivy, cs101 } = await seed();
		await testDb.db
			.updateTable("lti_contexts")
			.set({ nrps_url: null })
			.where("id", "=", cs101)
			.execute();
		const body = RosterSyncResponse.parse(
			(await sync(cs101, await cookieFor(ivy))).json(),
		);
		expect(body.roster.available).toBe(false);
		expect(lms.tokenHits).toBe(0);
	},
);

test.skipIf(skip)("only one sync of a course runs at a time", async () => {
	const { ivy, tom, cs101 } = await seed();
	lms.members = [ivyEntry];
	lms.delayMs = 200;
	const [first, second] = await Promise.all([
		sync(cs101, await cookieFor(ivy)),
		sync(cs101, await cookieFor(tom)),
	]);
	expect(first.statusCode).toBe(200);
	expect(second.json()).toEqual(first.json());
	expect(lms.tokenHits).toBe(1);
	expect(await audits("course.roster_synced")).toHaveLength(1);
});

test.skipIf(skip)(
	"opening the Course page refreshes a roster at most once an hour",
	async () => {
		const { ivy, cs101 } = await seed();
		const cookie = await cookieFor(ivy);
		lms.members = [
			ivyEntry,
			{ user_id: "sub-rosa", name: "Rosa Roster", roles: [LEARNER] },
		];

		const first = CourseMembersResponse.parse((await members(cs101, cookie)).json());
		// The page answers at once; the refresh runs behind it.
		expect(first.roster.syncedAt).toBeNull();
		await vi.waitFor(async () => {
			expect((await courseRow(cs101)).roster_sync_result).toBe("ok");
		});
		expect(lms.tokenHits).toBe(1);

		const second = CourseMembersResponse.parse((await members(cs101, cookie)).json());
		expect(second.roster.result).toBe("ok");
		expect(second.members.map((m) => m.displayName)).toContain("Rosa Roster");
		expect(lms.tokenHits).toBe(1);

		await testDb.db
			.updateTable("lti_contexts")
			.set({ roster_synced_at: new Date(Date.now() - 61 * 60 * 1000).toISOString() })
			.where("id", "=", cs101)
			.execute();
		await members(cs101, cookie);
		await vi.waitFor(() => expect(lms.tokenHits).toBe(2));
		await vi.waitFor(async () => {
			const row = await courseRow(cs101);
			expect(Date.now() - new Date(row.roster_synced_at ?? 0).getTime()).toBeLessThan(
				60_000,
			);
		});
	},
);

test.skipIf(skip)(
	"sync answers 404 to anyone but an instructor of that course",
	async () => {
		const { sam, cs101 } = await seed();
		const admin = await insertTestUser(testDb.db, { role: "administrator" });
		const other = await insertTestLtiUser(testDb.db, ISSUER, { role: "instructor" });
		const cs240 = await insertTestLtiMembership(testDb.db, other, {
			issuer: ISSUER,
			contextId: "cs240",
			role: "instructor",
		});
		const cases: Array<[string, string, string]> = [
			["a student of the course", cs101, await cookieFor(sam)],
			["an administrator", cs101, await cookieFor(admin)],
			["another course's instructor", cs101, await cookieFor(other)],
			["an unknown course", crypto.randomUUID(), await cookieFor(other)],
			["a bad id", "not-a-uuid", await cookieFor(other)],
		];
		for (const [name, courseId, cookie] of cases) {
			expect((await sync(courseId, cookie)).statusCode, name).toBe(404);
		}
		expect(cs240).not.toBe(cs101);
		const anonymous = await app.inject({
			method: "POST",
			url: `/courses/${cs101}/roster/sync`,
			headers: { origin: PUBLIC_URL },
		});
		expect(anonymous.statusCode).toBe(401);
		expect(lms.tokenHits).toBe(0);
	},
);

test.skipIf(skip)(
	"no name, subject or token reaches the logs or the audit rows",
	async () => {
		const { ivy, cs101 } = await seed();
		const cookie = await cookieFor(ivy);
		lms.members = [
			ivyEntry,
			{ user_id: "sub-rosa", name: "Rosa Roster", roles: [LEARNER] },
		];
		await sync(cs101, cookie);
		lms.membersStatus = 500;
		await sync(cs101, cookie);
		lms.tokenStatus = 403;
		await sync(cs101, cookie);
		await members(cs101, cookie);

		const synced = await audits("course.roster_synced");
		expect(synced.map((row) => row.result)).toEqual(["ok", "failed", "failed"]);
		expect(synced[0]?.metadata).toEqual({
			result: "ok",
			matched: 1,
			notStarted: 1,
			removed: 3,
			roleChanged: 0,
		});
		expect(synced[1]?.metadata).toEqual({ result: "fetch_failed", status: 500 });
		expect(synced[2]?.metadata).toEqual({ result: "token_failed", status: 403 });

		const auditText = JSON.stringify(
			await testDb.db.selectFrom("audit_events").selectAll().execute(),
		);
		const logText = JSON.stringify(lines);
		expect(logText).toContain("roster sync failed");
		for (const secret of [
			"Rosa",
			"Ivy",
			"Tom",
			"Sam",
			"Lee",
			"sub-",
			ACCESS_TOKEN,
			"BEGIN PRIVATE KEY",
		]) {
			expect(auditText, secret).not.toContain(secret);
			expect(logText, secret).not.toContain(secret);
		}
	},
);
