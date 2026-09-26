import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createTestDb, hasTestDb, type TestDb } from "@portikus/db/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import type { DexApi, DexPassword } from "./dex-api.js";
import {
	formatImportReport,
	type ImportedUser,
	importUsersFile,
	parseUsersFile,
} from "./dex-import.js";
import { dexLocalSubject } from "./dex-subject.js";

const DEX = "https://portikus.example.edu:8443/dex";
const HASH = "$2b$12$MGOrI4Vq522K69kyskhWsetEom1fjLdaDyzNB.G7ktesUbWKQEFfG";

function user(username: string, role: ImportedUser["role"], n: number): ImportedUser {
	return {
		username,
		email: `${username}@example.edu`,
		displayName: username,
		userId: `${n}${n}${n}${n}${n}${n}${n}${n}-1111-4111-8111-111111111111`,
		passwordHash: HASH,
		role,
	};
}
const carol = user("carol", "administrator", 1);
const alice = user("alice", "student", 2);
const ivy = user("ivy", "instructor", 3);

/** An in-memory Dex that can be told to refuse the nth create. */
function fakeDex(failOnCreate?: number, failDelete = false) {
	const passwords = new Map<string, DexPassword & { hash: string }>();
	let creates = 0;
	const dex: DexApi = {
		async createPassword(input) {
			creates += 1;
			if (creates === failOnCreate) throw new Error("unavailable");
			if (passwords.has(input.email)) return "already_exists";
			passwords.set(input.email, input);
			return "created";
		},
		async updatePassword() {
			return "not_found";
		},
		async deletePassword(email) {
			if (failDelete) throw new Error("unavailable");
			return passwords.delete(email) ? "deleted" : "not_found";
		},
		async listPasswords() {
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
	return { dex, passwords };
}

describe("parseUsersFile", () => {
	test("accepts a version 1 file and keeps the fields the import needs", () => {
		const users = parseUsersFile({ version: 1, users: [{ ...carol, extra: 1 }] });
		expect(users).toEqual([carol]);
	});

	test.each([
		[{ version: 2, users: [carol] }, "version 1"],
		[{ version: 1, users: [] }, "version 1"],
		[{ version: 1, users: [{ ...carol, role: "teacher" }] }, "users[0].role"],
		[{ version: 1, users: [{ ...carol, userId: "" }] }, "users[0].userId"],
	])("refuses %j", (raw, message) => {
		expect(() => parseUsersFile(raw)).toThrow(message);
	});

	test("never names a hash in its errors", () => {
		expect(() =>
			parseUsersFile({ version: 1, users: [{ ...carol, role: "x" }] }),
		).not.toThrow(HASH);
	});
});

test("the report names usernames only", () => {
	const text = formatImportReport({
		status: "imported",
		usernames: ["carol", "alice"],
		granted: ["carol"],
		precreated: [],
	});
	expect(text).toBe(
		"Imported into Dex: carol, alice\nGrants set: carol\nAccounts created for a grant: none\n",
	);
	expect(formatImportReport({ status: "skipped", passwordsInDex: 3 })).toContain(
		"nothing imported",
	);
});

const main = fileURLToPath(new URL("./dex-import-main.ts", import.meta.url));
function run(args: string[], env: Record<string, string | undefined> = {}) {
	return spawnSync(process.execPath, ["--import", "tsx", main, ...args], {
		encoding: "utf8",
		env: { ...process.env, DATABASE_URL: undefined, DEX_GRPC_ADDR: undefined, ...env },
	});
}

test("the command refuses bad arguments and missing settings", () => {
	expect(run([]).stderr).toContain("--input is required");
	expect(run(["--input", "x.json"]).stderr).toContain("--issuer is required");
	expect(run(["--input", "x.json", "--issuer", DEX]).stderr).toContain(
		"DATABASE_URL is not set",
	);
	expect(run(["--bogus"]).status).toBe(2);
});

if (!hasTestDb()) {
	console.log("TEST_DATABASE_URL is not set — skipping dex-import database tests.");
}

describe.skipIf(!hasTestDb())("importUsersFile", () => {
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

	async function account(u: ImportedUser, role = "student", provider = role) {
		return t.db
			.insertInto("users")
			.values({
				oidc_issuer: DEX,
				oidc_subject: dexLocalSubject(u.userId),
				email: u.email,
				display_name: u.username,
				role,
				provider_role: provider,
			})
			.returning("id")
			.executeTakeFirstOrThrow();
	}

	function row(u: ImportedUser) {
		return t.db
			.selectFrom("users")
			.select(["id", "role", "provider_role", "granted_role"])
			.where("oidc_issuer", "=", DEX)
			.where("oidc_subject", "=", dexLocalSubject(u.userId))
			.executeTakeFirst();
	}

	test("every entry reaches Dex with its own user ID and hash, so every subject stays", async () => {
		const { dex, passwords } = fakeDex();
		const ids = [await account(carol, "administrator"), await account(alice)];
		const report = await importUsersFile(t.db, dex, DEX, [carol, alice]);
		expect(report).toEqual({
			status: "imported",
			usernames: ["carol", "alice"],
			granted: ["carol"],
			precreated: [],
		});
		expect(passwords.get(carol.email)).toEqual({
			email: carol.email,
			username: "carol",
			userId: carol.userId,
			hash: HASH,
		});
		expect(passwords.get(alice.email)?.userId).toBe(alice.userId);
		// The same rows, found by the subject Dex will send.
		expect((await row(carol))?.id).toBe(ids[0]?.id);
		expect((await row(alice))?.id).toBe(ids[1]?.id);
	});

	test("an administrator from the file keeps administrator by grant once Dex sends no groups", async () => {
		const { dex } = fakeDex();
		await account(carol, "administrator");
		await importUsersFile(t.db, dex, DEX, [carol]);
		expect(await row(carol)).toMatchObject({
			role: "administrator",
			provider_role: "administrator",
			granted_role: "administrator",
		});
		const audits = await t.db
			.selectFrom("audit_events")
			.select(["actor", "action", "metadata"])
			.execute();
		expect(audits).toEqual([
			{
				actor: "operator:dex-import",
				action: "user.role_changed",
				metadata: { from: "administrator", to: "administrator", source: "import" },
			},
			{
				actor: "operator:dex-import",
				action: "dex.users_imported",
				metadata: { users: 1 },
			},
		]);
	});

	test("an instructor who never signed in gets an account holding the grant; students get nothing", async () => {
		const { dex } = fakeDex();
		const report = await importUsersFile(t.db, dex, DEX, [ivy, alice]);
		expect(report).toMatchObject({ precreated: ["ivy"], granted: [] });
		expect(await row(ivy)).toMatchObject({
			role: "instructor",
			provider_role: "student",
			granted_role: "instructor",
		});
		expect(await row(alice)).toBeUndefined();
	});

	test("an instructor entry never lowers an administrator grant", async () => {
		const { dex } = fakeDex();
		const { id } = await account(ivy, "administrator", "student");
		await t.db
			.updateTable("users")
			.set({ granted_role: "administrator" })
			.where("id", "=", id)
			.execute();
		await importUsersFile(t.db, dex, DEX, [ivy]);
		expect(await row(ivy)).toMatchObject({
			role: "administrator",
			granted_role: "administrator",
		});
	});

	test("a second run imports nothing and changes nothing", async () => {
		const { dex, passwords } = fakeDex();
		await account(carol, "administrator");
		await importUsersFile(t.db, dex, DEX, [carol, alice]);
		await t.db.updateTable("users").set({ granted_role: null }).execute();
		const again = await importUsersFile(t.db, dex, DEX, [carol, alice, ivy]);
		expect(again).toMatchObject({ status: "already_imported" });
		expect(passwords.size).toBe(2);
		expect((await row(carol))?.granted_role).toBeNull();
		expect(await row(ivy)).toBeUndefined();
	});

	test("a failure part way leaves an empty Dex and no grants, so the next run starts over", async () => {
		const { dex, passwords } = fakeDex(2);
		await account(carol, "administrator");
		await expect(importUsersFile(t.db, dex, DEX, [carol, alice])).rejects.toThrow(
			"unavailable",
		);
		expect(passwords.size).toBe(0);
		expect((await row(carol))?.granted_role).toBeNull();
		expect(await t.db.selectFrom("audit_events").select("id").execute()).toEqual([]);
	});

	test("an email Dex already holds stops the import and undoes it", async () => {
		const { dex, passwords } = fakeDex();
		const twin = { ...alice, username: "alice2", userId: ivy.userId };
		await expect(importUsersFile(t.db, dex, DEX, [alice, twin])).rejects.toThrow(
			"already has a password for alice2",
		);
		expect(passwords.size).toBe(0);
	});

	test("a run after an administrator removed every Dex user still imports nothing", async () => {
		const { dex, passwords } = fakeDex();
		await importUsersFile(t.db, dex, DEX, [carol, alice]);
		passwords.clear();
		const again = await importUsersFile(t.db, dex, DEX, [carol, alice]);
		expect(again).toMatchObject({ status: "already_imported" });
		expect(formatImportReport(again)).toContain("already imported");
		expect(passwords.size).toBe(0);
	});

	test("a Dex that already holds passwords is left alone even before any import", async () => {
		const { dex, passwords } = fakeDex();
		await dex.createPassword({ ...alice, hash: HASH });
		const report = await importUsersFile(t.db, dex, DEX, [carol]);
		expect(report).toEqual({ status: "skipped", passwordsInDex: 1 });
		expect(passwords.size).toBe(1);
	});

	test("a skipped run marks the site imported, so a later empty Dex never imports", async () => {
		const { dex, passwords } = fakeDex();
		await dex.createPassword({ ...alice, hash: HASH });
		await importUsersFile(t.db, dex, DEX, [carol]);
		passwords.clear();
		const again = await importUsersFile(t.db, dex, DEX, [carol]);
		expect(again).toMatchObject({ status: "already_imported" });
		expect(passwords.size).toBe(0);
	});

	test("a disabled account gets no grant back from the file", async () => {
		const { dex } = fakeDex();
		const { id } = await account(carol);
		await t.db
			.updateTable("users")
			.set({ disabled_at: new Date().toISOString() })
			.where("id", "=", id)
			.execute();
		const report = await importUsersFile(t.db, dex, DEX, [carol]);
		expect(report).toMatchObject({ granted: [], precreated: [] });
		expect(await row(carol)).toMatchObject({ role: "student", granted_role: null });
	});

	test("an instructor entry raises a student account by grant", async () => {
		const { dex } = fakeDex();
		await account(ivy);
		const report = await importUsersFile(t.db, dex, DEX, [ivy]);
		expect(report).toMatchObject({ granted: ["ivy"] });
		expect(await row(ivy)).toMatchObject({
			role: "instructor",
			granted_role: "instructor",
		});
	});

	test("a cleanup that fails names the Dex passwords left behind", async () => {
		const { dex, passwords } = fakeDex(2, true);
		await expect(importUsersFile(t.db, dex, DEX, [carol, alice])).rejects.toThrow(
			"could not remove these Dex passwords again, delete them before the next run: carol",
		);
		expect(passwords.size).toBe(1);
	});
});
