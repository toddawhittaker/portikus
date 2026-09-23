import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createTestDb, hasTestDb, type TestDb } from "@portikus/db/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { dexLocalSubject } from "./dex-subject.js";
import {
	type DeployedUser,
	formatUsersRevokeReport,
	parseUsersRevokeInput,
	revokeDeployedUsers,
	usersToRevoke,
} from "./users-revoke.js";

const DEX = "https://portikus.example.edu:8443/dex";
const CAROL_ID = "11111111-1111-4111-8111-111111111111";
const ALICE_ID = "22222222-2222-4222-8222-222222222222";
const BOB_ID = "33333333-3333-4333-8333-333333333333";

const carol: DeployedUser = {
	username: "carol",
	userId: CAROL_ID,
	role: "administrator",
	passwordFingerprint: "c1",
};
const alice: DeployedUser = {
	username: "alice",
	userId: ALICE_ID,
	role: "student",
	passwordFingerprint: "a1",
};
const bob: DeployedUser = {
	username: "bob",
	userId: BOB_ID,
	role: "student",
	passwordFingerprint: "b1",
};

describe("usersToRevoke", () => {
	test("an unchanged file revokes nobody", () => {
		expect(usersToRevoke([carol, alice], [alice, carol])).toEqual([]);
	});

	test("a removed user is revoked", () => {
		expect(usersToRevoke([carol, alice], [carol])).toEqual([alice]);
	});

	test("a new password is revoked", () => {
		expect(usersToRevoke([alice], [{ ...alice, passwordFingerprint: "a2" }])).toEqual([
			alice,
		]);
	});

	test("a demoted administrator is revoked, a promoted student is not", () => {
		expect(
			usersToRevoke(
				[carol, alice],
				[
					{ ...carol, role: "student" },
					{ ...alice, role: "administrator" },
				],
			),
		).toEqual([carol]);
	});

	test("a new user and a new email or name change nothing", () => {
		expect(usersToRevoke([alice], [{ ...alice, username: "alice2" }, bob])).toEqual([]);
	});

	test("a username given to a different userId revokes the old one", () => {
		expect(usersToRevoke([alice], [{ ...alice, userId: BOB_ID }])).toEqual([alice]);
	});
});

describe("parseUsersRevokeInput", () => {
	test("accepts the documented shape, first deploy included", () => {
		const input = { issuer: DEX, previous: null, next: [alice] };
		expect(parseUsersRevokeInput(JSON.parse(JSON.stringify(input)))).toEqual(input);
		const again = { issuer: DEX, previous: [alice], next: [] };
		expect(parseUsersRevokeInput(again)).toEqual(again);
	});

	test.each([
		["a list, not an object", []],
		["no issuer", { issuer: "", previous: null, next: [] }],
		["next missing", { issuer: DEX, previous: null }],
		["previous not a list", { issuer: DEX, previous: "x", next: [] }],
		[
			"a user without a fingerprint",
			{ issuer: DEX, previous: null, next: [{ ...alice, passwordFingerprint: "" }] },
		],
		["a user that is not an object", { issuer: DEX, previous: null, next: [1] }],
	])("refuses %s", (_name, bad) => {
		expect(() => parseUsersRevokeInput(bad)).toThrow();
	});
});

test("the report names usernames and a count only", () => {
	expect(formatUsersRevokeReport({ usernames: [], sessionsRevoked: 0 })).toBe(
		"No account lost access.\n",
	);
	expect(
		formatUsersRevokeReport({ usernames: ["alice", "carol"], sessionsRevoked: 3 }),
	).toBe("Sessions ended for: alice, carol\nSessions revoked: 3\n");
});

const main = fileURLToPath(new URL("./users-revoke-main.ts", import.meta.url));
function run(args: string[]) {
	return spawnSync(process.execPath, ["--import", "tsx", main, ...args], {
		encoding: "utf8",
		env: { ...process.env, DATABASE_URL: undefined },
	});
}

test("the command refuses bad arguments and a missing DATABASE_URL", () => {
	expect(run([]).stderr).toContain("--input is required");
	expect(run(["--apply"]).status).toBe(2);
	expect(run(["--input", "x.json"]).stderr).toContain("DATABASE_URL is not set");
});

if (!hasTestDb()) {
	console.log("TEST_DATABASE_URL is not set — skipping users-revoke database tests.");
}

describe.skipIf(!hasTestDb())("revokeDeployedUsers", () => {
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

	async function dexUser(userId: string, issuer = DEX) {
		const row = await t.db
			.insertInto("users")
			.values({
				oidc_issuer: issuer,
				oidc_subject: dexLocalSubject(userId),
				email: `${userId}@example.edu`,
				display_name: userId,
				role: "student",
			})
			.returning("id")
			.executeTakeFirstOrThrow();
		n += 1;
		await t.db
			.insertInto("sessions")
			.values({ id: `s-${n}`, user_id: row.id, expires_at: "2999-01-01T00:00:00Z" })
			.execute();
		return row.id;
	}

	async function sessionsOf(userId: string) {
		return t.db
			.selectFrom("sessions")
			.select("id")
			.where("user_id", "=", userId)
			.execute();
	}

	async function revokeAudits() {
		return t.db
			.selectFrom("audit_events")
			.select(["actor", "metadata"])
			.where("action", "=", "auth.sessions_revoked")
			.execute();
	}

	test("ends only the changed users' sessions and audits usernames", async () => {
		const aliceRow = await dexUser(ALICE_ID);
		const carolRow = await dexUser(CAROL_ID);
		// The same userId under another issuer is not this deploy's account.
		const otherRow = await dexUser(ALICE_ID, "https://elsewhere.example.edu");
		const ws = await t.db
			.insertInto("workspaces")
			.values({ label: `ur-${Date.now()}`, owner_user_id: aliceRow, state: "running" })
			.returning("id")
			.executeTakeFirstOrThrow();
		const [aliceSession] = await sessionsOf(aliceRow);
		await t.db
			.insertInto("preview_sessions")
			.values({
				token_hash: "h",
				user_id: aliceRow,
				session_id: aliceSession?.id ?? "",
				workspace_id: ws.id,
				port: 3000,
				preview_host: "p.example.edu",
			})
			.execute();

		const report = await revokeDeployedUsers(t.db, {
			issuer: DEX,
			previous: [carol, alice],
			next: [{ ...carol, role: "student" }],
		});

		expect(report).toEqual({ usernames: ["carol", "alice"], sessionsRevoked: 2 });
		expect(await sessionsOf(aliceRow)).toEqual([]);
		expect(await sessionsOf(carolRow)).toEqual([]);
		expect(await sessionsOf(otherRow)).toHaveLength(1);
		expect(await t.db.selectFrom("preview_sessions").select("id").execute()).toEqual(
			[],
		);
		const audits = await revokeAudits();
		expect(audits).toHaveLength(1);
		expect(audits[0]?.actor).toBe("operator:users-deploy");
		expect(audits[0]?.metadata).toEqual({
			reason: "users-deploy",
			usernames: ["carol", "alice"],
			count: 2,
		});
		expect(JSON.stringify(audits[0]?.metadata)).not.toContain("c1");
	});

	test("the first deploy and an unchanged deploy touch nothing", async () => {
		const aliceRow = await dexUser(ALICE_ID);
		for (const previous of [null, [alice]]) {
			const report = await revokeDeployedUsers(t.db, {
				issuer: DEX,
				previous,
				next: [alice],
			});
			expect(report).toEqual({ usernames: [], sessionsRevoked: 0 });
		}
		expect(await sessionsOf(aliceRow)).toHaveLength(1);
		expect(await revokeAudits()).toEqual([]);
	});

	test("a removed user who never signed in is still audited, with no sessions", async () => {
		const report = await revokeDeployedUsers(t.db, {
			issuer: DEX,
			previous: [bob],
			next: [],
		});
		expect(report).toEqual({ usernames: ["bob"], sessionsRevoked: 0 });
		expect(await revokeAudits()).toHaveLength(1);
	});
});
