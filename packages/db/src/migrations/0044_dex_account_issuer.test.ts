import type { Kysely } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import {
	createTestDb,
	hasTestDb,
	insertTestLtiUser,
	insertTestUser,
	type TestDb,
} from "../testing.js";
import { up } from "./0044_dex_account_issuer.js";

/**
 * Dex accounts move to the logical issuer so an address move keeps them
 * (SPEC.md section 5.1; ADR 0031). The rows are written after the schema
 * is at latest, then `up` runs on them directly.
 */

const DEX = "urn:portikus:dex";
const OLD = "https://old.example.edu/dex";
const NEW = "https://new.example.edu:8443/dex";

if (!hasTestDb()) {
	console.log("TEST_DATABASE_URL is not set — skipping migration 0044 tests.");
}

describe.skipIf(!hasTestDb())("migration 0044_dex_account_issuer", () => {
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

	const migrate = () => up(t.db as unknown as Kysely<unknown>);

	/** A Dex row whose sign-in and creation times the duplicate rule reads. */
	async function dexRow(
		issuer: string,
		subject: string,
		times: { last_login_at?: string; created_at?: string } = {},
	): Promise<string> {
		const row = await t.db
			.insertInto("users")
			.values({
				oidc_issuer: issuer,
				oidc_subject: subject,
				display_name: subject,
				role: "student",
				...times,
			})
			.returning("id")
			.executeTakeFirstOrThrow();
		return row.id;
	}

	async function issuerOf(id: string): Promise<string> {
		const row = await t.db
			.selectFrom("users")
			.select("oidc_issuer")
			.where("id", "=", id)
			.executeTakeFirstOrThrow();
		return row.oidc_issuer;
	}

	test("a Dex account keeps its id, workspace and link under the logical issuer", async () => {
		const sso = await insertTestUser(t.db, {
			oidc_issuer: OLD,
			oidc_subject: "CgVhbGljZRIFbG9jYWw",
		});
		const course = await insertTestLtiUser(t.db);
		const workspace = crypto.randomUUID();
		await t.db
			.insertInto("workspaces")
			.values({
				id: workspace,
				owner_user_id: sso,
				incus_instance_name: `ws-${workspace.slice(0, 8)}`,
				label: "alice",
				state: "stopped",
				desired_state: "stopped",
			})
			.execute();
		await t.db
			.insertInto("account_links")
			.values({
				course_user_id: course,
				user_id: sso,
				platform_issuer: "https://lms.test.invalid",
				archived_at: null,
			})
			.execute();

		await migrate();

		const row = await t.db
			.selectFrom("users")
			.select(["oidc_issuer", "oidc_subject"])
			.where("id", "=", sso)
			.executeTakeFirstOrThrow();
		expect(row).toEqual({ oidc_issuer: DEX, oidc_subject: "CgVhbGljZRIFbG9jYWw" });
		const owned = await t.db
			.selectFrom("workspaces")
			.select("owner_user_id")
			.where("id", "=", workspace)
			.executeTakeFirstOrThrow();
		expect(owned.owner_user_id).toBe(sso);
		const link = await t.db
			.selectFrom("account_links")
			.select(["user_id", "course_user_id"])
			.executeTakeFirstOrThrow();
		expect(link).toEqual({ user_id: sso, course_user_id: course });
		expect(await issuerOf(course)).toBe("lti:https://lms.test.invalid");
	});

	test("course, test-suite and other providers' rows are untouched", async () => {
		const lti = await insertTestLtiUser(t.db, "https://lms.example.edu/dex");
		const sectest = await insertTestUser(t.db, { oidc_issuer: "urn:portikus:sectest" });
		const other = await insertTestUser(t.db, {
			oidc_issuer: "https://idp.example.edu",
		});
		await migrate();
		expect(await issuerOf(lti)).toBe("lti:https://lms.example.edu/dex");
		expect(await issuerOf(sectest)).toBe("urn:portikus:sectest");
		expect(await issuerOf(other)).toBe("https://idp.example.edu");
	});

	test("of one subject under two addresses, only the latest-used row moves", async () => {
		// The newer address was created later but never signed into.
		const used = await dexRow(OLD, "a", { last_login_at: "2026-10-05T00:00:00Z" });
		const unused = await dexRow(NEW, "a", { created_at: "2026-10-01T00:00:00Z" });
		// Here the newer address is the later one.
		const before = await dexRow(OLD, "b", { last_login_at: "2026-09-01T00:00:00Z" });
		const after = await dexRow(NEW, "b", { created_at: "2026-10-01T00:00:00Z" });
		const alone = await dexRow(NEW, "c");

		await migrate();

		expect(await issuerOf(used)).toBe(DEX);
		expect(await issuerOf(unused)).toBe(NEW);
		expect(await issuerOf(after)).toBe(DEX);
		expect(await issuerOf(before)).toBe(OLD);
		expect(await issuerOf(alone)).toBe(DEX);
	});

	test("running twice changes nothing more", async () => {
		const kept = await dexRow(OLD, "s");
		await migrate();
		// An address row made after the first run, for a subject already moved.
		const stray = await dexRow(NEW, "s", { last_login_at: new Date().toISOString() });
		await migrate();
		expect(await issuerOf(kept)).toBe(DEX);
		expect(await issuerOf(stray)).toBe(NEW);
	});
});
