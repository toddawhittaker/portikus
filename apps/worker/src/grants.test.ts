/**
 * The worker's database role gets only what its queries need, and nothing
 * that could make it an administrator (SPEC.md §24.9, ADR 0044).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createDb, type Database } from "@portikus/db";
import {
	createTestDb,
	hasTestDb,
	insertTestUser,
	type TestDb,
} from "@portikus/db/testing";
import { collectingLogger } from "@portikus/observability/testing";
import { type Kysely, sql } from "kysely";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { backupVmTick, pullRequest } from "./backups.js";
import { createEgressSync } from "./egress.js";
import { FakeControllerClient } from "./fake-controller.js";
import { createGuard } from "./guard.js";
import { createHealthSampler } from "./health.js";
import { seedSettings } from "./index.js";
import { createLimitsSync } from "./limits.js";
import { createLogLevelSync } from "./log-level.js";
import { notifyAdministrators, pruneNotifications } from "./notifications.js";
import { createPackageSurvey } from "./package-survey.js";
import { serveProcessSnapshots } from "./process-snapshots.js";
import { createQuotaSync } from "./quota.js";
import { reconcile, settleStops } from "./reconcile.js";

const GRANTS_FILE = join(
	import.meta.dirname,
	"../../../infra/ansible/roles/portikus/files/worker-grants.sql",
);
const grantsSql = readFileSync(GRANTS_FILE, "utf8");

type Verb = "SELECT" | "INSERT" | "UPDATE" | "DELETE";

/** Table to the verbs the file grants, column grants included. */
function granted(): Map<string, Set<Verb>> {
	const out = new Map<string, Set<Verb>>();
	const body = grantsSql.replace(/--.*$/gm, "").replace(/\s+/g, " ");
	for (const m of body.matchAll(
		/GRANT ([A-Z, ]+?)(?: \([^)]*\))? ON (?!SEQUENCE)([a-z_, ]+?) TO /g,
	)) {
		const verbs = (m[1] ?? "").split(",").map((v) => v.trim() as Verb);
		for (const table of (m[2] ?? "").split(",").map((t) => t.trim())) {
			const set = out.get(table) ?? new Set<Verb>();
			for (const v of verbs) set.add(v);
			out.set(table, set);
		}
	}
	return out;
}

/** Table to the verbs the worker's own source uses on it. */
function used(): Map<string, Set<Verb>> {
	const out = new Map<string, Set<Verb>>();
	const add = (table: string, ...verbs: Verb[]) => {
		const set = out.get(table) ?? new Set<Verb>();
		for (const v of verbs) set.add(v);
		out.set(table, set);
	};
	const files = readdirSync(import.meta.dirname).filter(
		(f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== "fake-controller.ts",
	);
	for (const file of files) {
		const text = readFileSync(join(import.meta.dirname, file), "utf8");
		const builder =
			/(selectFrom|innerJoin|leftJoin|insertInto|updateTable|deleteFrom)\("([a-z_]+)/g;
		for (const [, call, table] of text.matchAll(builder)) {
			if (!table) continue;
			// A WHERE clause reads, so every write also needs SELECT.
			if (call === "insertInto") add(table, "INSERT");
			else if (call === "updateTable") add(table, "UPDATE", "SELECT");
			else if (call === "deleteFrom") add(table, "DELETE", "SELECT");
			else add(table, "SELECT");
		}
		for (const [, raw] of text.matchAll(/sql(?:<[^>]*>)?`([^`]*)`/g)) {
			const words = /\b(update|delete from|insert into|from|join)\s+([a-z_]+)/g;
			for (const [, verb, table] of (raw ?? "").matchAll(words)) {
				if (!table || !knownTables.has(table)) continue;
				if (verb === "update") add(table, "UPDATE", "SELECT");
				else if (verb === "delete from") add(table, "DELETE", "SELECT");
				else if (verb === "insert into") add(table, "INSERT");
				else add(table, "SELECT");
			}
		}
	}
	return out;
}

/** The tables `Database` in packages/db/src/schema.ts names. */
function schemaTables(): Set<string> {
	const schema = readFileSync(
		join(import.meta.dirname, "../../../packages/db/src/schema.ts"),
		"utf8",
	);
	const body = schema.split("export interface Database {")[1]?.split("}")[0] ?? "";
	return new Set([...body.matchAll(/^\t([a-z_]+):/gm)].map((m) => m[1] ?? ""));
}
const knownTables = schemaTables();

/** Tables whose rows sign someone in or say who they are. */
const AUTH_TABLES = [
	"sessions",
	"preview_grants",
	"preview_sessions",
	"lti_login_states",
	"lti_contexts",
	"lti_memberships",
	"account_links",
	"account_link_intents",
];

describe("worker-grants.sql", () => {
	test("grants every verb the worker's queries use", () => {
		const have = granted();
		const missing: string[] = [];
		for (const [table, verbs] of used()) {
			for (const verb of verbs) {
				if (!have.get(table)?.has(verb)) missing.push(`${verb} on ${table}`);
			}
		}
		expect(missing).toEqual([]);
	});

	test("grants nothing on an auth table and only SELECT on users", () => {
		const have = granted();
		for (const table of AUTH_TABLES) expect(have.get(table), table).toBeUndefined();
		expect([...(have.get("users") ?? [])]).toEqual(["SELECT"]);
		expect(grantsSql).toMatch(/REVOKE portikus FROM "portikus-worker"/);
	});

	test("names only tables that exist", () => {
		for (const table of granted().keys())
			expect(knownTables.has(table), table).toBe(true);
	});
});

const skip = !hasTestDb();
const role = `pk_worker_test_${process.pid}`;
let tdb: TestDb;
let worker: Kysely<Database>;

/** Run the grants file for a role of this test's own; roles are server-wide. */
beforeAll(async () => {
	if (skip) return;
	tdb = await createTestDb();
	await sql
		.raw(`DROP ROLE IF EXISTS "${role}"; CREATE ROLE "${role}" NOLOGIN`)
		.execute(tdb.db);
	await sql.raw(grantsSql.replaceAll('"portikus-worker"', `"${role}"`)).execute(tdb.db);
	// A startup option makes every connection act as the role, as peer auth does.
	const url = new URL(process.env.TEST_DATABASE_URL ?? "");
	url.searchParams.set("options", `-c role=${role}`);
	worker = createDb(url.toString(), 2);
});

afterAll(async () => {
	if (skip) return;
	await worker.destroy();
	// close() points TEST_DATABASE_URL back at the shared database.
	await tdb.close();
	const server = createDb(process.env.TEST_DATABASE_URL ?? "", 1);
	await sql.raw(`DROP ROLE IF EXISTS "${role}"`).execute(server);
	await server.destroy();
});

describe.skipIf(skip)("the worker's role", () => {
	test("runs every worker loop without a permission error", async () => {
		const admin = await insertTestUser(tdb.db, { role: "administrator" });
		const student = await insertTestUser(tdb.db, { shutdown_grace_seconds: 60 });
		await tdb.db
			.insertInto("workspaces")
			.values({
				label: "grants-ws",
				owner_user_id: student,
				incus_instance_name: "ws-grants",
				state: "running",
				desired_state: "running",
				disconnected_at: new Date(Date.now() - 3_600_000).toISOString(),
			})
			.execute();
		expect(admin).toBeTruthy();

		const { logger, lines } = collectingLogger("debug");
		const controller = new FakeControllerClient();
		const now = () => new Date();
		await seedSettings(worker, 600);
		await notifyAdministrators(worker, { tone: "warning", title: "t", body: "b" });
		await pruneNotifications(worker, new Date());
		await reconcile(
			worker,
			controller,
			{
				PRESENCE_TTL_SECONDS: 60,
				SHUTDOWN_GRACE_SECONDS: 600,
				START_TIMEOUT_SECONDS: 60,
				STOP_TIMEOUT_SECONDS: 30,
				STATUS_REFRESH_SECONDS: 15,
				WORKSPACE_HOME_SIZE_GIB: 25,
				WORKSPACE_DOCKER_SIZE_GIB: 20,
				WORKSPACE_RECOVERY_SIZE_GIB: 3,
				PREVIEW_SUFFIX: "preview.example.edu",
			},
			new Date(),
			null,
			false,
			logger,
		);
		await settleStops();
		const opts = { db: worker, controller, logger, now };
		await createHealthSampler(opts)();
		await createGuard(opts)();
		await createEgressSync(opts)();
		await createQuotaSync(opts)();
		await createLimitsSync(opts)();
		await createPackageSurvey(opts)();
		await createLogLevelSync({ db: worker, logger, envLevel: "info", controller })();
		await serveProcessSnapshots(worker, controller, logger);
		await backupVmTick({ db: worker, controller, logger });
		await pullRequest(worker, new Date());

		expect(JSON.stringify(lines)).not.toMatch(/permission denied/i);
		const stopped = await tdb.db
			.selectFrom("workspaces")
			.select("state")
			.where("label", "=", "grants-ws")
			.executeTakeFirstOrThrow();
		expect(stopped.state).not.toBe("running");
	});

	test("cannot sign anyone in or change who is an administrator", async () => {
		const someone = await insertTestUser(tdb.db);
		const denied = /permission denied/;
		await expect(
			sql`insert into sessions (id, user_id, expires_at) values ('forged', ${someone}, now() + interval '1 day')`.execute(
				worker,
			),
		).rejects.toThrow(denied);
		await expect(sql`select id from sessions`.execute(worker)).rejects.toThrow(denied);
		await expect(
			worker
				.insertInto("users")
				.values({
					oidc_issuer: "x",
					oidc_subject: "y",
					display_name: "z",
					role: "administrator",
				})
				.execute(),
		).rejects.toThrow(denied);
		await expect(
			worker
				.updateTable("users")
				.set({ role: "administrator" })
				.where("id", "=", someone)
				.execute(),
		).rejects.toThrow(denied);
		await expect(
			worker.updateTable("settings").set({ egress_mode: "open" }).execute(),
		).rejects.toThrow(denied);
		await expect(worker.deleteFrom("audit_events").execute()).rejects.toThrow(denied);
	});
});
