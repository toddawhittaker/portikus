import { createTestDb, hasTestDb, type TestDb } from "@portikus/db/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import {
	type CarryOverInput,
	carryOver,
	formatReport,
	parseCarryOverInput,
} from "./carry-over.js";
import { dexLocalSubject } from "./dex-subject.js";

const DEX = "https://portikus.example.edu:8443/dex";
const MOCK = "https://portikus.example.edu:8443/mock-idp";
const OLD_MOCK = "https://portikus.example.edu/mock-idp";

const CAROL_ID = "11111111-1111-4111-8111-111111111111";
const ALICE_ID = "22222222-2222-4222-8222-222222222222";
const DAVE_ID = "33333333-3333-4333-8333-333333333333";

const input: CarryOverInput = {
	toIssuer: DEX,
	fromIssuers: [MOCK, OLD_MOCK],
	users: [
		{ email: "Carol@Example.edu", username: "carol", userId: CAROL_ID },
		{ email: "alice@example.edu", username: "alice", userId: ALICE_ID },
		{ email: "dave@example.edu", username: "dave", userId: DAVE_ID },
	],
};

describe("parseCarryOverInput", () => {
	test("accepts the documented shape", () => {
		expect(parseCarryOverInput(JSON.parse(JSON.stringify(input)))).toEqual(input);
	});

	test.each([
		["no toIssuer", { ...input, toIssuer: "" }],
		["empty fromIssuers", { ...input, fromIssuers: [] }],
		["toIssuer among fromIssuers", { ...input, fromIssuers: [DEX] }],
		["a user without userId", { ...input, users: [{ email: "a@b", username: "a" }] }],
		[
			"two users with one email in different case",
			{
				...input,
				users: [
					{ email: "a@b.edu", username: "a", userId: CAROL_ID },
					{ email: "A@B.edu", username: "b", userId: ALICE_ID },
				],
			},
		],
		[
			"two users with one userId",
			{
				...input,
				users: [
					{ email: "a@b.edu", username: "a", userId: CAROL_ID },
					{ email: "c@b.edu", username: "b", userId: CAROL_ID },
				],
			},
		],
		["a list, not an object", []],
	])("refuses %s", (_name, bad) => {
		expect(() => parseCarryOverInput(bad)).toThrow();
	});
});

if (!hasTestDb()) {
	console.log("TEST_DATABASE_URL is not set — skipping carry-over database tests.");
}

describe.skipIf(!hasTestDb())("carryOver", () => {
	let t: TestDb;
	let n = 0;

	beforeAll(async () => {
		t = await createTestDb();
	});
	afterAll(async () => {
		await t?.close();
	});
	beforeEach(async () => {
		await t.truncate();
	});

	async function user(
		issuer: string,
		subject: string,
		email: string,
		lastLogin?: string,
	) {
		const row = await t.db
			.insertInto("users")
			.values({
				oidc_issuer: issuer,
				oidc_subject: subject,
				email,
				display_name: subject,
				role: "student",
				last_login_at: lastLogin ?? null,
			})
			.returning(["id", "updated_at"])
			.executeTakeFirstOrThrow();
		n += 1;
		await t.db
			.insertInto("workspaces")
			.values({
				label: `co-${n}-${Date.now()}`,
				owner_user_id: row.id,
				state: "stopped",
			})
			.execute();
		return row;
	}

	async function session(userId: string) {
		n += 1;
		const id = `s-${n}`;
		await t.db
			.insertInto("sessions")
			.values({ id, user_id: userId, expires_at: "2999-01-01T00:00:00Z" })
			.execute();
		return id;
	}

	async function rows() {
		return t.db.selectFrom("users").selectAll().orderBy("id").execute();
	}

	/** The pilot's #302 case: carol has a row under each mock issuer, both owning a workspace. */
	async function seedPilot() {
		const carolNew = await user(
			MOCK,
			"carol",
			"carol@example.edu",
			"2026-09-20T00:00:00Z",
		);
		const carolOld = await user(
			OLD_MOCK,
			"carol",
			"carol@example.edu",
			"2026-09-21T00:00:00Z",
		);
		const aliceOld = await user(OLD_MOCK, "alice", "alice@example.edu");
		const sectest = await user("urn:portikus:sectest", "carol", "carol@example.edu");
		const smoke = await user(
			"urn:portikus:smoketest",
			"smoke-1-alice",
			"alice@example.edu",
		);
		const carolSession = await session(carolNew.id);
		await session(sectest.id);
		const ws = await t.db
			.selectFrom("workspaces")
			.select(["id", "owner_user_id"])
			.where("owner_user_id", "=", carolNew.id)
			.executeTakeFirstOrThrow();
		await t.db
			.insertInto("preview_sessions")
			.values({
				token_hash: "h",
				user_id: carolNew.id,
				session_id: carolSession,
				workspace_id: ws.id,
				port: 3000,
				preview_host: "p",
			})
			.execute();
		return { carolNew, carolOld, aliceOld, sectest, smoke };
	}

	test("the dry run reports every user and changes nothing", async () => {
		const seeded = await seedPilot();
		const before = await rows();

		const report = await carryOver(t.db, input, { apply: false });

		expect(report.applied).toBe(false);
		expect(report.users).toEqual([
			{
				email: "Carol@Example.edu",
				username: "carol",
				status: "carried",
				rowId: seeded.carolNew.id,
				fromIssuer: MOCK,
				leftBehind: [seeded.carolOld.id],
			},
			{
				email: "alice@example.edu",
				username: "alice",
				status: "carried",
				rowId: seeded.aliceOld.id,
				fromIssuer: OLD_MOCK,
				leftBehind: [],
			},
			{ email: "dave@example.edu", username: "dave", status: "new", leftBehind: [] },
		]);
		expect(report.sessionsRevoked).toBe(0);
		expect(await rows()).toEqual(before);
		expect(await t.db.selectFrom("audit_events").selectAll().execute()).toEqual([]);
		expect(await t.db.selectFrom("sessions").selectAll().execute()).toHaveLength(2);
		expect(formatReport(report)).toContain("dry run");
	});

	test("--apply rewrites exactly the chosen rows, audits each, and revokes sessions once", async () => {
		const seeded = await seedPilot();
		const before = new Map((await rows()).map((r) => [r.id, r]));

		const report = await carryOver(t.db, input, { apply: true });
		expect(report.applied).toBe(true);
		expect(report.sessionsRevoked).toBe(2);

		const after = await rows();
		for (const row of after) {
			const old = before.get(row.id);
			if (row.id === seeded.carolNew.id) {
				expect(row.oidc_issuer).toBe(DEX);
				expect(row.oidc_subject).toBe(dexLocalSubject(CAROL_ID));
				expect(row.updated_at.getTime()).toBeGreaterThanOrEqual(
					old?.updated_at.getTime() ?? 0,
				);
			} else if (row.id === seeded.aliceOld.id) {
				expect(row.oidc_issuer).toBe(DEX);
				expect(row.oidc_subject).toBe(dexLocalSubject(ALICE_ID));
			} else {
				expect(row).toEqual(old);
			}
		}

		// Both carol rows still own their workspaces.
		const owners = await t.db
			.selectFrom("workspaces")
			.select("owner_user_id")
			.execute();
		expect(owners.map((o) => o.owner_user_id)).toContain(seeded.carolNew.id);
		expect(owners.map((o) => o.owner_user_id)).toContain(seeded.carolOld.id);

		const audit = await t.db
			.selectFrom("audit_events")
			.selectAll()
			.orderBy("id")
			.execute();
		expect(audit.map((a) => [a.actor, a.action, a.target])).toEqual([
			["operator:carry-over", "user.identity_changed", seeded.carolNew.id],
			["operator:carry-over", "user.identity_changed", seeded.aliceOld.id],
			["operator:carry-over", "auth.sessions_revoked", "sessions"],
		]);
		expect(audit[0]?.metadata).toEqual({
			fromIssuer: MOCK,
			toIssuer: DEX,
			username: "carol",
		});
		expect(audit[2]?.metadata).toEqual({
			reason: "identity-provider-cutover",
			count: 2,
		});

		expect(await t.db.selectFrom("sessions").selectAll().execute()).toEqual([]);
		expect(await t.db.selectFrom("preview_sessions").selectAll().execute()).toEqual([]);
	});

	test("a second --apply changes nothing and revokes nothing", async () => {
		await seedPilot();
		await carryOver(t.db, input, { apply: true });
		const between = await rows();
		const auditCount = (await t.db.selectFrom("audit_events").selectAll().execute())
			.length;
		await session(between[0]?.id ?? "");

		const report = await carryOver(t.db, input, { apply: true });

		expect(report.users.map((u) => u.status)).toEqual(["linked", "linked", "new"]);
		expect(report.sessionsRevoked).toBe(0);
		expect(await rows()).toEqual(between);
		expect(await t.db.selectFrom("audit_events").selectAll().execute()).toHaveLength(
			auditCount,
		);
		expect(await t.db.selectFrom("sessions").selectAll().execute()).toHaveLength(1);
	});

	test("never touches rows outside fromIssuers, even with a matching email", async () => {
		await user("urn:portikus:sectest", "carol", "carol@example.edu");
		await user("urn:portikus:smoketest", "smoke-1-alice", "alice@example.edu");
		await user("https://other.example.edu", "dave", "dave@example.edu");
		const before = await rows();

		const report = await carryOver(t.db, input, { apply: true });

		expect(report.users.map((u) => u.status)).toEqual(["new", "new", "new"]);
		expect(await rows()).toEqual(before);
		expect(await t.db.selectFrom("audit_events").selectAll().execute()).toEqual([]);
	});

	test("an email that only differs by more than case is not a match", async () => {
		await user(MOCK, "carol", "carol@example.edu.evil");
		await user(MOCK, "carol2", " carol@example.edu");
		const before = await rows();

		const report = await carryOver(t.db, input, { apply: true });

		expect(report.users[0]?.status).toBe("new");
		expect(await rows()).toEqual(before);
	});
});
