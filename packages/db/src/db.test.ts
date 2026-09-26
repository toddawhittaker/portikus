import { type Kysely, sql } from "kysely";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import {
	basePrefix,
	createTestDb,
	hasTestDb,
	hostId,
	insertTestLtiMembership,
	insertTestLtiUser,
	insertTestUser,
	type TestDb,
} from "./testing.js";

/** Workspace labels are unique, so each test row needs its own. */
let labelCounter = 0;
function testLabel(): string {
	return `ws-test-${++labelCounter}`;
}

if (!hasTestDb()) {
	console.log(
		"TEST_DATABASE_URL is not set — skipping database tests. " +
			"See docs/WORKFLOW.md for how to run a local Postgres.",
	);
}

describe("database migrations and schema", () => {
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

	test.skipIf(!hasTestDb())("migrate twice is idempotent", async () => {
		const { migrateToLatest } = await import("./migrate.js");
		const applied = await migrateToLatest(t.db);
		expect(applied).toEqual([]);
	});

	test.skipIf(!hasTestDb())("workspaces table accepts a valid row", async () => {
		const userId = await insertTestUser(t.db);
		const row = await t.db
			.insertInto("workspaces")
			.values({
				label: testLabel(),
				owner_user_id: userId,
				state: "provisioning",
			})
			.returningAll()
			.executeTakeFirstOrThrow();

		expect(row.owner_user_id).toBe(userId);
		expect(row.state).toBe("provisioning");
		expect(row.desired_state).toBe("stopped");
		expect(row.id).toBeTruthy();
		expect(row.created_at).toBeInstanceOf(Date);
	});

	test.skipIf(!hasTestDb())("workspaces rejects duplicate owner_user_id", async () => {
		const userId = await insertTestUser(t.db);
		await t.db
			.insertInto("workspaces")
			.values({ label: testLabel(), owner_user_id: userId, state: "provisioning" })
			.execute();

		await expect(
			t.db
				.insertInto("workspaces")
				.values({
					label: testLabel(),
					owner_user_id: userId,
					state: "provisioning",
				})
				.execute(),
		).rejects.toThrow(/unique|duplicate/i);
	});

	test.skipIf(!hasTestDb())("workspaces rejects an invalid state", async () => {
		const userId = await insertTestUser(t.db);
		await expect(
			t.db
				.insertInto("workspaces")
				.values({
					label: testLabel(),
					owner_user_id: userId,
					state: "flying",
				})
				.execute(),
		).rejects.toThrow(/check|violates/i);
	});

	test.skipIf(!hasTestDb())("workspace_connections accepts a valid row", async () => {
		const ws = await t.db
			.insertInto("workspaces")
			.values({
				label: testLabel(),
				owner_user_id: await insertTestUser(t.db),
				state: "running",
			})
			.returning("id")
			.executeTakeFirstOrThrow();

		const conn = await t.db
			.insertInto("workspace_connections")
			.values({ workspace_id: ws.id })
			.returningAll()
			.executeTakeFirstOrThrow();

		expect(conn.workspace_id).toBe(ws.id);
		expect(conn.connected_at).toBeInstanceOf(Date);
	});

	test.skipIf(!hasTestDb())(
		"cascade delete removes connections when workspace is deleted",
		async () => {
			const ws = await t.db
				.insertInto("workspaces")
				.values({
					label: testLabel(),
					owner_user_id: await insertTestUser(t.db),
					state: "running",
				})
				.returning("id")
				.executeTakeFirstOrThrow();

			await t.db
				.insertInto("workspace_connections")
				.values({ workspace_id: ws.id })
				.execute();

			await t.db.deleteFrom("workspaces").where("id", "=", ws.id).execute();

			const remaining = await t.db
				.selectFrom("workspace_connections")
				.where("workspace_id", "=", ws.id)
				.selectAll()
				.execute();

			expect(remaining).toHaveLength(0);
		},
	);

	test.skipIf(!hasTestDb())("audit_events table accepts a valid row", async () => {
		const row = await t.db
			.insertInto("audit_events")
			.values({
				actor: "system",
				target: "ws-abc123",
				action: "workspace.provision_requested",
				result: "success",
				metadata: JSON.stringify({ foo: "bar" }),
			})
			.returningAll()
			.executeTakeFirstOrThrow();

		expect(Number(row.id)).toBeGreaterThan(0);
		expect(row.action).toBe("workspace.provision_requested");
		expect(row.at).toBeInstanceOf(Date);
	});

	test.skipIf(!hasTestDb())(
		"users rejects a duplicate issuer and subject pair",
		async () => {
			await insertTestUser(t.db, { oidc_subject: "subject-dup" });

			const err = await t.db
				.insertInto("users")
				.values({
					oidc_issuer: "https://test.invalid",
					oidc_subject: "subject-dup",
					display_name: "Test User",
					role: "student",
				})
				.execute()
				.catch((e: { code?: string }) => e);

			expect((err as { code?: string }).code).toBe("23505");
		},
	);

	test.skipIf(!hasTestDb())("deleting a user cascades to its sessions", async () => {
		const userId = await insertTestUser(t.db);
		await t.db
			.insertInto("sessions")
			.values({
				id: "session-cascade",
				user_id: userId,
				expires_at: new Date(Date.now() + 60_000).toISOString(),
			})
			.execute();

		await t.db.deleteFrom("users").where("id", "=", userId).execute();

		const remaining = await t.db
			.selectFrom("sessions")
			.where("user_id", "=", userId)
			.selectAll()
			.execute();
		expect(remaining).toHaveLength(0);
	});

	test.skipIf(!hasTestDb())("workspaces rejects an unknown owner", async () => {
		const err = await t.db
			.insertInto("workspaces")
			.values({
				label: testLabel(),
				owner_user_id: "00000000-0000-0000-0000-000000000000",
				state: "provisioning",
			})
			.execute()
			.catch((e: { code?: string }) => e);

		expect((err as { code?: string }).code).toBe("23503");
	});

	test.skipIf(!hasTestDb())("terminals table accepts a valid row", async () => {
		const ws = await t.db
			.insertInto("workspaces")
			.values({
				label: testLabel(),
				owner_user_id: await insertTestUser(t.db),
				state: "running",
			})
			.returning("id")
			.executeTakeFirstOrThrow();

		const row = await t.db
			.insertInto("terminals")
			.values({
				workspace_id: ws.id,
				name: "shell",
				cwd: "/home/student",
			})
			.returningAll()
			.executeTakeFirstOrThrow();

		expect(row.workspace_id).toBe(ws.id);
		expect(row.position).toBe(0);
		expect(row.ended_at).toBeNull();
		expect(row.created_at).toBeInstanceOf(Date);
		// A shell has no launcher and no review baseline (SPEC.md §10.8).
		expect(row.agent).toBeNull();
		expect(row.baseline_object_id).toBeNull();
		expect(row.baseline_head).toBeNull();
	});

	test.skipIf(!hasTestDb())(
		"a terminal can record a launcher and its baseline",
		async () => {
			const ws = await t.db
				.insertInto("workspaces")
				.values({
					label: testLabel(),
					owner_user_id: await insertTestUser(t.db),
					state: "running",
				})
				.returning("id")
				.executeTakeFirstOrThrow();
			const sha = "a".repeat(40);
			const head = "b".repeat(64);
			const row = await t.db
				.insertInto("terminals")
				.values({
					workspace_id: ws.id,
					name: "claude",
					cwd: "/home/student/projects/essay",
					agent: "claude",
					baseline_object_id: sha,
					baseline_head: head,
				})
				.returning(["agent", "baseline_object_id", "baseline_head"])
				.executeTakeFirstOrThrow();
			expect(row.agent).toBe("claude");
			expect(row.baseline_object_id).toBe(sha);
			expect(row.baseline_head).toBe(head);
		},
	);

	// --- migration 0010: the terminal's own colour scheme (issue #268) ---

	test.skipIf(!hasTestDb())(
		"a terminal is dark unless the row says light",
		async () => {
			const ws = await t.db
				.insertInto("workspaces")
				.values({
					label: testLabel(),
					owner_user_id: await insertTestUser(t.db),
					state: "running",
				})
				.returning("id")
				.executeTakeFirstOrThrow();

			const fallback = await t.db
				.insertInto("terminals")
				.values({ workspace_id: ws.id, name: "shell", cwd: "/home/student" })
				.returning("theme")
				.executeTakeFirstOrThrow();
			expect(fallback.theme).toBe("dark");

			const chosen = await t.db
				.insertInto("terminals")
				.values({
					workspace_id: ws.id,
					name: "bright",
					cwd: "/home/student",
					theme: "light",
				})
				.returning("theme")
				.executeTakeFirstOrThrow();
			expect(chosen.theme).toBe("light");
		},
	);

	test.skipIf(!hasTestDb())(
		"deleting a workspace cascades to its terminals",
		async () => {
			const ws = await t.db
				.insertInto("workspaces")
				.values({
					label: testLabel(),
					owner_user_id: await insertTestUser(t.db),
					state: "running",
				})
				.returning("id")
				.executeTakeFirstOrThrow();

			await t.db
				.insertInto("terminals")
				.values({ workspace_id: ws.id, name: "shell", cwd: "/home/student" })
				.execute();

			await t.db.deleteFrom("workspaces").where("id", "=", ws.id).execute();

			const remaining = await t.db
				.selectFrom("terminals")
				.where("workspace_id", "=", ws.id)
				.selectAll()
				.execute();
			expect(remaining).toHaveLength(0);
		},
	);

	test.skipIf(!hasTestDb())(
		"workspaces stores the agent token and address",
		async () => {
			const row = await t.db
				.insertInto("workspaces")
				.values({
					label: testLabel(),
					owner_user_id: await insertTestUser(t.db),
					state: "running",
					agent_token: "a".repeat(64),
					agent_address: "10.99.0.5",
				})
				.returningAll()
				.executeTakeFirstOrThrow();

			expect(row.agent_token).toBe("a".repeat(64));
			expect(row.agent_address).toBe("10.99.0.5");
		},
	);

	test.skipIf(!hasTestDb())("projects table accepts a valid row", async () => {
		const ws = await t.db
			.insertInto("workspaces")
			.values({
				label: testLabel(),
				owner_user_id: await insertTestUser(t.db),
				state: "running",
			})
			.returning("id")
			.executeTakeFirstOrThrow();

		const row = await t.db
			.insertInto("projects")
			.values({
				workspace_id: ws.id,
				slug: "demo",
				name: "Demo",
				path: "/home/student/projects/demo",
				source: "new",
			})
			.returningAll()
			.executeTakeFirstOrThrow();

		expect(row.state).toBe("active");
		expect(row.layout).toBeNull();
		expect(row.archived_at).toBeNull();
		expect(row.created_at).toBeInstanceOf(Date);
	});

	test.skipIf(!hasTestDb())("projects rejects a bad state or source", async () => {
		const ws = await t.db
			.insertInto("workspaces")
			.values({
				label: testLabel(),
				owner_user_id: await insertTestUser(t.db),
				state: "running",
			})
			.returning("id")
			.executeTakeFirstOrThrow();

		const base = {
			workspace_id: ws.id,
			name: "Demo",
			path: "/home/student/projects/demo",
		};

		await expect(
			t.db
				.insertInto("projects")
				.values({ ...base, slug: "a", source: "invented" })
				.execute(),
		).rejects.toThrow();

		await expect(
			t.db
				.insertInto("projects")
				.values({ ...base, slug: "b", source: "new", state: "deleted" })
				.execute(),
		).rejects.toThrow();
	});

	test.skipIf(!hasTestDb())(
		"projects rejects a duplicate slug per workspace",
		async () => {
			const ws = await t.db
				.insertInto("workspaces")
				.values({
					label: testLabel(),
					owner_user_id: await insertTestUser(t.db),
					state: "running",
				})
				.returning("id")
				.executeTakeFirstOrThrow();

			const values = {
				workspace_id: ws.id,
				slug: "demo",
				name: "Demo",
				path: "/home/student/projects/demo",
				source: "new",
			};
			await t.db.insertInto("projects").values(values).execute();
			await expect(
				t.db.insertInto("projects").values(values).execute(),
			).rejects.toThrow();
		},
	);

	test.skipIf(!hasTestDb())(
		"deleting a project leaves its terminals with a null project_id",
		async () => {
			const ws = await t.db
				.insertInto("workspaces")
				.values({
					label: testLabel(),
					owner_user_id: await insertTestUser(t.db),
					state: "running",
				})
				.returning("id")
				.executeTakeFirstOrThrow();

			const project = await t.db
				.insertInto("projects")
				.values({
					workspace_id: ws.id,
					slug: "demo",
					name: "Demo",
					path: "/home/student/projects/demo",
					source: "new",
				})
				.returning("id")
				.executeTakeFirstOrThrow();

			const terminal = await t.db
				.insertInto("terminals")
				.values({
					workspace_id: ws.id,
					name: "shell",
					cwd: "/home/student/projects/demo",
					project_id: project.id,
				})
				.returning("id")
				.executeTakeFirstOrThrow();

			await t.db.deleteFrom("projects").where("id", "=", project.id).execute();

			const row = await t.db
				.selectFrom("terminals")
				.where("id", "=", terminal.id)
				.selectAll()
				.executeTakeFirstOrThrow();
			expect(row.project_id).toBeNull();
		},
	);

	test.skipIf(!hasTestDb())("settings holds exactly one row, with id 1", async () => {
		await t.db
			.insertInto("settings")
			.values({ id: 1, shutdown_grace_seconds: 600 })
			.execute();
		const row = await t.db.selectFrom("settings").selectAll().executeTakeFirstOrThrow();
		expect(row.shutdown_grace_seconds).toBe(600);
		expect(row.updated_by).toBeNull();

		await expect(
			t.db
				.insertInto("settings")
				.values({ id: 2, shutdown_grace_seconds: 600 })
				.execute(),
		).rejects.toThrow();
	});

	test.skipIf(!hasTestDb())("settings rejects a negative grace period", async () => {
		await expect(
			t.db
				.insertInto("settings")
				.values({ id: 1, shutdown_grace_seconds: -1 })
				.execute(),
		).rejects.toThrow();
	});

	test.skipIf(!hasTestDb())(
		"a user grace override defaults to null and rejects negatives",
		async () => {
			const userId = await insertTestUser(t.db);
			const row = await t.db
				.selectFrom("users")
				.select("shutdown_grace_seconds")
				.where("id", "=", userId)
				.executeTakeFirstOrThrow();
			expect(row.shutdown_grace_seconds).toBeNull();

			await expect(
				t.db
					.updateTable("users")
					.set({ shutdown_grace_seconds: -1 })
					.where("id", "=", userId)
					.execute(),
			).rejects.toThrow();
		},
	);

	test.skipIf(!hasTestDb())("workspaces record a disconnect time", async () => {
		const userId = await insertTestUser(t.db);
		const row = await t.db
			.insertInto("workspaces")
			.values({
				label: testLabel(),
				owner_user_id: userId,
				state: "running",
				disconnected_at: new Date().toISOString(),
			})
			.returning("disconnected_at")
			.executeTakeFirstOrThrow();
		expect(row.disconnected_at).toBeInstanceOf(Date);
	});

	test.skipIf(!hasTestDb())(
		"a new user starts with empty editor settings",
		async () => {
			const userId = await insertTestUser(t.db);
			const row = await t.db
				.selectFrom("users")
				.select("editor_settings")
				.where("id", "=", userId)
				.executeTakeFirstOrThrow();
			expect(row.editor_settings).toEqual({});
		},
	);

	test.skipIf(!hasTestDb())("migrations roll back and reapply", async () => {
		const { Migrator } = await import("kysely/migration");
		const { migrations } = await import("./migrations/index.js");
		const rollback = new Error("rollback");

		// Runs inside a transaction that is always rolled back, so the
		// schema other tests share is left untouched.
		await expect(
			t.db.transaction().execute(async (trx) => {
				const migrator = new Migrator({
					db: trx,
					provider: { getMigrations: async () => migrations },
				});
				const down = await migrator.migrateDown();
				expect(down.error).toBeUndefined();
				const down2 = await migrator.migrateDown();
				expect(down2.error).toBeUndefined();
				const down3 = await migrator.migrateDown();
				expect(down3.error).toBeUndefined();
				const down4 = await migrator.migrateDown();
				expect(down4.error).toBeUndefined();
				const down5 = await migrator.migrateDown();
				expect(down5.error).toBeUndefined();
				const down6 = await migrator.migrateDown();
				expect(down6.error).toBeUndefined();
				const down7 = await migrator.migrateDown();
				expect(down7.error).toBeUndefined();
				const down8 = await migrator.migrateDown();
				expect(down8.error).toBeUndefined();
				const down9 = await migrator.migrateDown();
				expect(down9.error).toBeUndefined();
				const down10 = await migrator.migrateDown();
				expect(down10.error).toBeUndefined();
				const down11 = await migrator.migrateDown();
				expect(down11.error).toBeUndefined();
				const down12 = await migrator.migrateDown();
				expect(down12.error).toBeUndefined();
				const down13 = await migrator.migrateDown();
				expect(down13.error).toBeUndefined();
				const down14 = await migrator.migrateDown();
				expect(down14.error).toBeUndefined();
				const down15 = await migrator.migrateDown();
				expect(down15.error).toBeUndefined();
				const down16 = await migrator.migrateDown();
				expect(down16.error).toBeUndefined();
				const down17 = await migrator.migrateDown();
				expect(down17.error).toBeUndefined();
				const down18 = await migrator.migrateDown();
				expect(down18.error).toBeUndefined();
				const down19 = await migrator.migrateDown();
				expect(down19.error).toBeUndefined();
				const down20 = await migrator.migrateDown();
				expect(down20.error).toBeUndefined();
				const down21 = await migrator.migrateDown();
				expect(down21.error).toBeUndefined();
				const down22 = await migrator.migrateDown();
				expect(down22.error).toBeUndefined();
				const down23 = await migrator.migrateDown();
				expect(down23.error).toBeUndefined();
				const up = await migrator.migrateToLatest();
				expect(up.error).toBeUndefined();
				expect(up.results?.map((r) => r.migrationName)).toEqual([
					"0001_workspaces",
					"0002_users_sessions",
					"0003_terminals",
					"0004_projects",
					"0005_settings",
					"0006_log_level",
					"0007_editor_settings",
					"0008_preview",
					"0009_project_directory_id",
					"0010_terminal_theme",
					"0011_terminal_agent",
					"0012_profile",
					"0013_recovery",
					"0014_admin",
					"0015_lti",
					"0016_account_links",
					"0017_session_method",
					"0018_setup_codes",
					"0019_local_admin",
					"0020_resource_guard",
					"0021_notifications",
					"0023_guard_idle_lift",
					"0024_process_snapshots",
				]);
				throw rollback;
			}),
		).rejects.toBe(rollback);
	});

	// --- migration 0016: account links and the role grant (Epic 13.1) ---

	test.skipIf(!hasTestDb())(
		"0016 backfills provider_role from role and rolls back cleanly",
		async () => {
			const { Migrator } = await import("kysely/migration");
			const { migrations } = await import("./migrations/index.js");
			const rollback = new Error("rollback");

			await expect(
				t.db.transaction().execute(async (trx) => {
					const migrator = new Migrator({
						db: trx,
						provider: { getMigrations: async () => migrations },
					});
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0024_process_snapshots",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0023_guard_idle_lift",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0021_notifications",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0020_resource_guard",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0019_local_admin",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0018_setup_codes",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0017_session_method",
					);
					const down = await migrator.migrateDown();
					expect(down.error).toBeUndefined();
					expect(down.results?.[0]?.migrationName).toBe("0016_account_links");
					const gone = await sql<{ n: number }>`
					select count(*)::int as n from information_schema.tables
					where table_name in ('account_links', 'account_link_intents')`.execute(trx);
					expect(gone.rows[0]?.n).toBe(0);
					const columns = await sql<{ n: number }>`
					select count(*)::int as n from information_schema.columns
					where table_name = 'users' and column_name in ('provider_role', 'granted_role')`.execute(
						trx,
					);
					expect(columns.rows[0]?.n).toBe(0);

					const ids: Record<string, string> = {};
					for (const role of ["student", "instructor", "administrator"]) {
						const { rows } = await sql<{ id: string }>`
						insert into users (oidc_issuer, oidc_subject, display_name, role)
						values ('https://idp.test', ${role}, 'Someone', ${role}) returning id`.execute(
							trx,
						);
						ids[role] = rows[0]?.id as string;
					}

					const up = await migrator.migrateToLatest();
					expect(up.error).toBeUndefined();
					const rows = await trx
						.selectFrom("users")
						.select(["id", "role", "provider_role", "granted_role"])
						.execute();
					for (const role of ["student", "instructor", "administrator"]) {
						expect(rows.find((r) => r.id === ids[role])).toMatchObject({
							role,
							provider_role: role,
							granted_role: null,
						});
					}
					throw rollback;
				}),
			).rejects.toBe(rollback);
		},
	);

	// --- migration 0019: the local administrator (Epic 14.2) ---

	test.skipIf(!hasTestDb())(
		"0019 adds must_change_password, drops setup_codes, and rolls back cleanly",
		async () => {
			const { Migrator } = await import("kysely/migration");
			const { migrations } = await import("./migrations/index.js");
			const rollback = new Error("rollback");
			const userId = await insertTestUser(t.db);
			const flag = await t.db
				.selectFrom("users")
				.select("must_change_password")
				.where("id", "=", userId)
				.executeTakeFirstOrThrow();
			expect(flag.must_change_password).toBe(false);
			const table = sql<{ n: number }>`
				select count(*)::int as n from information_schema.tables
				where table_name = 'setup_codes'`;
			const column = sql<{ n: number }>`
				select count(*)::int as n from information_schema.columns
				where table_name = 'users' and column_name = 'must_change_password'`;
			expect((await table.execute(t.db)).rows[0]?.n).toBe(0);

			await expect(
				t.db.transaction().execute(async (trx) => {
					const migrator = new Migrator({
						db: trx,
						provider: { getMigrations: async () => migrations },
					});
					// Past 0024, 0023, 0021 and 0020 first.
					expect((await migrator.migrateDown()).error).toBeUndefined();
					expect((await migrator.migrateDown()).error).toBeUndefined();
					expect((await migrator.migrateDown()).error).toBeUndefined();
					expect((await migrator.migrateDown()).error).toBeUndefined();
					const down = await migrator.migrateDown();
					expect(down.error).toBeUndefined();
					expect(down.results?.[0]?.migrationName).toBe("0019_local_admin");
					expect((await table.execute(trx)).rows[0]?.n).toBe(1);
					expect((await column.execute(trx)).rows[0]?.n).toBe(0);
					const empty = await sql<{ n: number }>`
						select count(*)::int as n from setup_codes`.execute(trx);
					expect(empty.rows[0]?.n).toBe(0);
					const up = await migrator.migrateToLatest();
					expect(up.error).toBeUndefined();
					expect((await table.execute(trx)).rows[0]?.n).toBe(0);
					expect((await column.execute(trx)).rows[0]?.n).toBe(1);
					throw rollback;
				}),
			).rejects.toBe(rollback);
		},
	);

	// --- migration 0017: session method and the link's archive stamp (Epic 13.1 review) ---

	test.skipIf(!hasTestDb())(
		"0017 backfills session methods and the link's archive stamp, and rolls back",
		async () => {
			const { Migrator } = await import("kysely/migration");
			const { migrations } = await import("./migrations/index.js");
			const rollback = new Error("rollback");

			await expect(
				t.db.transaction().execute(async (trx) => {
					const plain = await insertTestUser(trx);
					const sso = await insertTestUser(trx);
					const unlinkedCourse = await insertTestLtiUser(
						trx,
						"https://third.test.invalid",
					);
					const course = await insertTestLtiUser(trx);
					const lateCourse = await insertTestLtiUser(trx, "https://other.test.invalid");
					const linkedAt = "2026-09-20T10:00:00.000Z";
					const stamp = "2026-09-20T10:00:02.000Z";
					const laterStamp = "2026-09-21T10:00:00.000Z";
					for (const [owner, archivedAt] of [
						[course, stamp],
						[lateCourse, laterStamp],
					] as const) {
						await trx
							.insertInto("workspaces")
							.values({
								label: testLabel(),
								owner_user_id: owner,
								state: "stopped",
								archived_at: archivedAt,
							})
							.execute();
					}
					const migrator = new Migrator({
						db: trx,
						provider: { getMigrations: async () => migrations },
					});
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0024_process_snapshots",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0023_guard_idle_lift",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0021_notifications",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0020_resource_guard",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0019_local_admin",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0018_setup_codes",
					);
					const down = await migrator.migrateDown();
					expect(down.error).toBeUndefined();
					expect(down.results?.[0]?.migrationName).toBe("0017_session_method");
					await sql`insert into sessions (id, user_id, expires_at) values
						('plain', ${plain}, now() + interval '1 hour'),
						('launch', ${unlinkedCourse}, now() + interval '1 hour'),
						('sso', ${sso}, now() + interval '1 hour'),
						('course', ${course}, now() + interval '1 hour')`.execute(trx);
					await sql`insert into account_links (course_user_id, user_id, platform_issuer, archived_workspace, created_at)
						values (${course}, ${sso}, 'https://lms.test.invalid', true, ${linkedAt}),
						       (${lateCourse}, ${sso}, 'https://other.test.invalid', true, ${linkedAt})`.execute(
						trx,
					);

					const up = await migrator.migrateToLatest();
					expect(up.error).toBeUndefined();
					const sessions = await trx
						.selectFrom("sessions")
						.select(["id", "method", "course_user_id"])
						.orderBy("id")
						.execute();
					// Both sides of a link lose their sessions; the rest are classified.
					expect(sessions).toEqual([
						{ id: "launch", method: "lti", course_user_id: null },
						{ id: "plain", method: "oidc", course_user_id: null },
					]);
					const links = await trx
						.selectFrom("account_links")
						.select(["course_user_id", "archived_at"])
						.execute();
					const archived = links.find((l) => l.course_user_id === course);
					expect(new Date(archived?.archived_at ?? 0).toISOString()).toBe(stamp);
					// An archive written a day after the link is not the link's.
					expect(
						links.find((l) => l.course_user_id === lateCourse)?.archived_at,
					).toBeNull();
					throw rollback;
				}),
			).rejects.toBe(rollback);
		},
	);

	test.skipIf(!hasTestDb())(
		"sessions refuse an unknown method and a course user on a non-launch session",
		async () => {
			const user = await insertTestUser(t.db);
			const course = await insertTestLtiUser(t.db);
			const row = (id: string) => ({
				id,
				user_id: user,
				expires_at: new Date(Date.now() + 60_000).toISOString(),
			});
			await expect(
				t.db
					.insertInto("sessions")
					.values({ ...row("a"), method: "password" })
					.execute(),
			).rejects.toThrow(/sessions_method_check/);
			await expect(
				t.db
					.insertInto("sessions")
					.values({ ...row("b"), method: "oidc", course_user_id: course })
					.execute(),
			).rejects.toThrow(/sessions_course_user_check/);
			await t.db
				.insertInto("sessions")
				.values({ ...row("c"), method: "lti", course_user_id: course })
				.execute();
		},
	);

	test.skipIf(!hasTestDb())(
		"a user inserted with only a role gets it as provider_role",
		async () => {
			const id = await insertTestUser(t.db, { role: "administrator" });
			const row = await t.db
				.selectFrom("users")
				.select(["provider_role", "granted_role"])
				.where("id", "=", id)
				.executeTakeFirstOrThrow();
			expect(row).toEqual({ provider_role: "administrator", granted_role: null });
		},
	);

	test.skipIf(!hasTestDb())("granted_role accepts only the two grants", async () => {
		const id = await insertTestUser(t.db);
		for (const grant of ["instructor", "administrator", null]) {
			await t.db
				.updateTable("users")
				.set({ granted_role: grant })
				.where("id", "=", id)
				.execute();
		}
		for (const grant of ["student", "owner"]) {
			await expect(
				t.db
					.updateTable("users")
					.set({ granted_role: grant })
					.where("id", "=", id)
					.execute(),
			).rejects.toThrow(/users_granted_role_check/);
		}
		await expect(
			t.db
				.updateTable("users")
				.set({ provider_role: "owner" })
				.where("id", "=", id)
				.execute(),
		).rejects.toThrow(/users_provider_role_check/);
	});

	test.skipIf(!hasTestDb())("a course account can never hold a grant", async () => {
		const id = await insertTestLtiUser(t.db);
		for (const grant of ["instructor", "administrator"]) {
			await expect(
				t.db
					.updateTable("users")
					.set({ granted_role: grant })
					.where("id", "=", id)
					.execute(),
			).rejects.toThrow(/users_granted_role_sso_check/);
		}
		await expect(
			insertTestLtiUser(t.db, "https://lms.test.invalid", {
				granted_role: "administrator",
			}),
		).rejects.toThrow(/users_granted_role_sso_check/);
	});

	test.skipIf(!hasTestDb())(
		"account_links: one per platform per SSO account, one per course account",
		async () => {
			const sso = await insertTestUser(t.db);
			const otherSso = await insertTestUser(t.db);
			const course = await insertTestLtiUser(t.db);
			const secondCourse = await insertTestLtiUser(t.db);
			const link = {
				course_user_id: course,
				user_id: sso,
				platform_issuer: "https://lms.test.invalid",
				archived_at: null,
			};
			await t.db.insertInto("account_links").values(link).execute();
			await expect(
				t.db
					.insertInto("account_links")
					.values({ ...link, course_user_id: secondCourse })
					.execute(),
			).rejects.toThrow(/account_links_user_platform_key/);
			await expect(
				t.db
					.insertInto("account_links")
					.values({ ...link, user_id: otherSso })
					.execute(),
			).rejects.toThrow(/account_links_pkey/);
			await expect(
				t.db
					.insertInto("account_links")
					.values({ ...link, course_user_id: sso, user_id: sso })
					.execute(),
			).rejects.toThrow(/account_links_distinct_check/);
			// Another platform may link to the same SSO account.
			await t.db
				.insertInto("account_links")
				.values({
					...link,
					course_user_id: secondCourse,
					platform_issuer: "https://other.lms",
				})
				.execute();

			await t.db.deleteFrom("users").where("id", "=", course).execute();
			const left = await t.db
				.selectFrom("account_links")
				.select("course_user_id")
				.execute();
			expect(left).toEqual([{ course_user_id: secondCourse }]);
		},
	);

	test.skipIf(!hasTestDb())(
		"account_link_intents: one per session, removed with the session",
		async () => {
			const course = await insertTestLtiUser(t.db);
			await t.db
				.insertInto("sessions")
				.values({
					id: "session-hash",
					user_id: course,
					expires_at: "2999-01-01T00:00:00Z",
				})
				.execute();
			const intent = {
				state_hash: "state-1",
				session_id: "session-hash",
				course_user_id: course,
				expires_at: "2999-01-01T00:00:00Z",
			};
			await t.db.insertInto("account_link_intents").values(intent).execute();
			await expect(
				t.db
					.insertInto("account_link_intents")
					.values({ ...intent, state_hash: "state-2" })
					.execute(),
			).rejects.toThrow(/account_link_intents_session_id_key/);
			await t.db.deleteFrom("sessions").where("id", "=", "session-hash").execute();
			expect(
				await t.db.selectFrom("account_link_intents").selectAll().execute(),
			).toEqual([]);
		},
	);

	test.skipIf(!hasTestDb())("the new tables carry their indexes", async () => {
		const { rows } = await sql<{ indexname: string; indexdef: string }>`
			SELECT indexname, indexdef FROM pg_indexes
			WHERE indexname IN ('account_links_user_id_idx', 'account_link_intents_expires_at_idx')
			ORDER BY indexname
		`.execute(t.db);
		expect(rows.map((r) => r.indexname)).toEqual([
			"account_link_intents_expires_at_idx",
			"account_links_user_id_idx",
		]);
	});

	// --- migration 0015: LTI launch and the instructor role (Epic 13) ---

	test.skipIf(!hasTestDb())(
		"the role check accepts instructor and refuses others",
		async () => {
			const id = await insertTestUser(t.db, { role: "instructor" });
			expect(id).toBeTruthy();
			// Since 0016 the copied provider_role check may fire first; either refuses.
			await expect(insertTestUser(t.db, { role: "teacher" })).rejects.toThrow(
				/users_(provider_)?role_check/,
			);
		},
	);

	test.skipIf(!hasTestDb())(
		"a membership role is student or instructor only",
		async () => {
			const userId = await insertTestLtiUser(t.db);
			await expect(
				insertTestLtiMembership(t.db, userId, { role: "administrator" as never }),
			).rejects.toThrow(/check constraint/);
		},
	);

	test.skipIf(!hasTestDb())(
		"a course is unique per platform and context id",
		async () => {
			const values = {
				platform_issuer: "https://lms.x",
				context_id: "c1",
				platform_name: "X",
			};
			const row = await t.db
				.insertInto("lti_contexts")
				.values(values)
				.returningAll()
				.executeTakeFirstOrThrow();
			expect(row.title).toBe("");
			await expect(
				t.db.insertInto("lti_contexts").values(values).execute(),
			).rejects.toThrow(/lti_contexts_platform_context_key/);
			await t.db
				.insertInto("lti_contexts")
				.values({ ...values, platform_issuer: "https://lms.y" })
				.execute();
		},
	);

	test.skipIf(!hasTestDb())(
		"deleting a user or a course removes its memberships",
		async () => {
			const a = await insertTestLtiUser(t.db);
			const b = await insertTestLtiUser(t.db);
			const courseId = await insertTestLtiMembership(t.db, a, { role: "instructor" });
			expect(await insertTestLtiMembership(t.db, b)).toBe(courseId);

			await t.db.deleteFrom("users").where("id", "=", a).execute();
			const left = await t.db.selectFrom("lti_memberships").select("user_id").execute();
			expect(left).toEqual([{ user_id: b }]);

			await t.db.deleteFrom("lti_contexts").where("id", "=", courseId).execute();
			expect(await t.db.selectFrom("lti_memberships").selectAll().execute()).toEqual(
				[],
			);
		},
	);

	test.skipIf(!hasTestDb())("lti_login_states stores a pending login", async () => {
		await t.db
			.insertInto("lti_login_states")
			.values({
				state_hash: "h1",
				nonce: "n1",
				platform_issuer: "https://lms.x",
				client_id: "cid",
				expires_at: new Date(Date.now() + 60_000).toISOString(),
			})
			.execute();
		await expect(
			t.db
				.insertInto("lti_login_states")
				.values({
					state_hash: "h1",
					nonce: "n2",
					platform_issuer: "https://lms.x",
					client_id: "cid",
					expires_at: new Date().toISOString(),
				})
				.execute(),
		).rejects.toThrow(/duplicate key/);
	});

	test.skipIf(!hasTestDb())("lti_login_states is indexed by expiry", async () => {
		const { rows } = await sql<{ indexdef: string }>`
			SELECT indexdef FROM pg_indexes
			WHERE tablename = 'lti_login_states' AND indexname = 'lti_login_states_expires_at_idx'
		`.execute(t.db);
		expect(rows[0]?.indexdef).toMatch(/\(expires_at\)/);
	});

	test.skipIf(!hasTestDb())(
		"0015 down drops the LTI tables and turns instructors into students",
		async () => {
			const { Migrator } = await import("kysely/migration");
			const { migrations } = await import("./migrations/index.js");
			const rollback = new Error("rollback");

			await expect(
				t.db.transaction().execute(async (trx) => {
					const userId = await insertTestUser(trx, { role: "instructor" });
					const migrator = new Migrator({
						db: trx,
						provider: { getMigrations: async () => migrations },
					});
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0024_process_snapshots",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0023_guard_idle_lift",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0021_notifications",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0020_resource_guard",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0019_local_admin",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0018_setup_codes",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0017_session_method",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0016_account_links",
					);
					const down = await migrator.migrateDown();
					expect(down.error).toBeUndefined();
					expect(down.results?.[0]?.migrationName).toBe("0015_lti");
					const gone = await sql<{ n: number }>`
					select count(*)::int as n from information_schema.tables
					where table_name like 'lti\_%'`.execute(trx);
					expect(gone.rows[0]?.n).toBe(0);
					const row = await trx
						.selectFrom("users")
						.select("role")
						.where("id", "=", userId)
						.executeTakeFirstOrThrow();
					expect(row.role).toBe("student");
					await sql`savepoint s`.execute(trx);
					await expect(insertTestUser(trx, { role: "instructor" })).rejects.toThrow(
						/users_role_check/,
					);
					await sql`rollback to savepoint s`.execute(trx);

					const up = await migrator.migrateToLatest();
					expect(up.error).toBeUndefined();
					throw rollback;
				}),
			).rejects.toBe(rollback);
		},
	);

	// --- migration 0014: admin columns, health samples, audit indexes (Epic 11) ---

	test.skipIf(!hasTestDb())(
		"0014 backfills quota_applied with only home and docker and rolls back",
		async () => {
			const { Migrator } = await import("kysely/migration");
			const { migrations } = await import("./migrations/index.js");
			const rollback = new Error("rollback");

			await expect(
				t.db.transaction().execute(async (trx) => {
					const migrator = new Migrator({
						db: trx,
						provider: { getMigrations: async () => migrations },
					});
					await migrator.migrateDown();
					await migrator.migrateDown();
					await migrator.migrateDown();
					await migrator.migrateDown();
					await migrator.migrateDown();
					await migrator.migrateDown();
					await migrator.migrateDown();
					await migrator.migrateDown();
					const down15 = await migrator.migrateDown();
					expect(down15.results?.[0]?.migrationName).toBe("0015_lti");
					const down = await migrator.migrateDown();
					expect(down.results?.[0]?.migrationName).toBe("0014_admin");
					const gone = await sql<{ n: number }>`
					select count(*)::int as n from information_schema.tables
					where table_name = 'health_samples'`.execute(trx);
					expect(gone.rows[0]?.n).toBe(0);

					const userId = await insertTestUser(trx);
					await trx
						.insertInto("workspaces")
						.values({
							label: testLabel(),
							owner_user_id: userId,
							state: "stopped",
							quota_config: JSON.stringify({
								homeGiB: 25,
								dockerGiB: 20,
								recoveryGiB: 10,
							}),
						} as never)
						.execute();

					const up = await migrator.migrateToLatest();
					expect(up.error).toBeUndefined();
					const row = await trx
						.selectFrom("workspaces")
						.select(["quota_applied", "archived_at"])
						.where("owner_user_id", "=", userId)
						.executeTakeFirstOrThrow();
					expect(row.quota_applied).toEqual({ homeGiB: 25, dockerGiB: 20 });
					expect(row.archived_at).toBeNull();
					throw rollback;
				}),
			).rejects.toBe(rollback);
		},
	);

	test.skipIf(!hasTestDb())(
		"health_samples stores a sample with a default time",
		async () => {
			const row = await t.db
				.insertInto("health_samples")
				.values({ sample: JSON.stringify({ controller: { reachable: false } }) })
				.returningAll()
				.executeTakeFirstOrThrow();
			expect(row.observed_at).toBeInstanceOf(Date);
			expect(row.sample).toEqual({ controller: { reachable: false } });
			await t.db.deleteFrom("health_samples").execute();
		},
	);

	test.skipIf(!hasTestDb())(
		"a migration that arrives after a later one has applied still runs",
		async () => {
			const { migrateToLatest } = await import("./migrate.js");
			const { migrations } = await import("./migrations/index.js");
			const rollback = new Error("rollback");

			// Stands in for Epic 10's 0013 landing after 0014 is already applied.
			const late = {
				...migrations,
				"0013_standin": {
					up: async (db: Kysely<unknown>) => {
						await db.schema
							.createTable("standin_0013")
							.addColumn("id", "integer")
							.execute();
					},
					down: async (db: Kysely<unknown>) => {
						await db.schema.dropTable("standin_0013").execute();
					},
				},
			};

			await expect(
				t.db.transaction().execute(async (trx) => {
					expect(await migrateToLatest(trx, late)).toEqual(["0013_standin"]);
					throw rollback;
				}),
			).rejects.toBe(rollback);
		},
	);

	// --- migration 0008: workspace label and preview tables ---
	// SPEC.md Epic 8; BROWSER-HANDLING.md sections 8 and 17.

	test.skipIf(!hasTestDb())("two workspaces cannot share a label", async () => {
		await t.db
			.insertInto("workspaces")
			.values({
				label: "tw7",
				owner_user_id: await insertTestUser(t.db),
				state: "provisioning",
			})
			.execute();

		await expect(
			t.db
				.insertInto("workspaces")
				.values({
					label: "tw7",
					owner_user_id: await insertTestUser(t.db),
					state: "provisioning",
				})
				.execute(),
		).rejects.toThrow(/unique|duplicate/i);
	});

	test.skipIf(!hasTestDb())("a workspace must have a label", async () => {
		await expect(
			t.db
				.insertInto("workspaces")
				.values({
					owner_user_id: await insertTestUser(t.db),
					state: "provisioning",
					// biome-ignore lint/suspicious/noExplicitAny: deliberately invalid row
				} as any)
				.execute(),
		).rejects.toThrow(/null/i);
	});

	test.skipIf(!hasTestDb())("the users table stores preferred_username", async () => {
		const userId = await insertTestUser(t.db);
		await t.db
			.updateTable("users")
			.set({ preferred_username: "tw7" })
			.where("id", "=", userId)
			.execute();

		const row = await t.db
			.selectFrom("users")
			.select("preferred_username")
			.where("id", "=", userId)
			.executeTakeFirstOrThrow();
		expect(row.preferred_username).toBe("tw7");
	});

	test.skipIf(!hasTestDb())("a preview grant round-trips", async () => {
		const userId = await insertTestUser(t.db);
		const ws = await t.db
			.insertInto("workspaces")
			.values({ label: "tw7", owner_user_id: userId, state: "running" })
			.returning("id")
			.executeTakeFirstOrThrow();
		await t.db
			.insertInto("sessions")
			.values({
				id: "grant-session",
				user_id: userId,
				expires_at: new Date(Date.now() + 60_000).toISOString(),
			})
			.execute();

		const grant = await t.db
			.insertInto("preview_grants")
			.values({
				user_id: userId,
				session_id: "grant-session",
				workspace_id: ws.id,
				port: 5173,
				preview_host: "tw7-5173.preview.localhost",
				presentation: "embedded",
				ticket_hash: "a".repeat(64),
				expires_at: new Date(Date.now() + 30_000).toISOString(),
			})
			.returningAll()
			.executeTakeFirstOrThrow();

		expect(grant.consumed_at).toBeNull();
		expect(grant.port).toBe(5173);

		await expect(
			t.db
				.insertInto("preview_grants")
				.values({
					user_id: userId,
					session_id: "grant-session",
					workspace_id: ws.id,
					port: 3000,
					preview_host: "tw7-3000.preview.localhost",
					presentation: "top-level",
					ticket_hash: "a".repeat(64),
					expires_at: new Date().toISOString(),
				})
				.execute(),
		).rejects.toThrow(/unique|duplicate/i);
	});

	test.skipIf(!hasTestDb())(
		"a preview grant rejects an unknown presentation",
		async () => {
			const userId = await insertTestUser(t.db);
			const ws = await t.db
				.insertInto("workspaces")
				.values({ label: "tw7", owner_user_id: userId, state: "running" })
				.returning("id")
				.executeTakeFirstOrThrow();
			await t.db
				.insertInto("sessions")
				.values({
					id: "grant-session",
					user_id: userId,
					expires_at: new Date(Date.now() + 60_000).toISOString(),
				})
				.execute();

			await expect(
				t.db
					.insertInto("preview_grants")
					.values({
						user_id: userId,
						session_id: "grant-session",
						workspace_id: ws.id,
						port: 5173,
						preview_host: "tw7-5173.preview.localhost",
						presentation: "popup",
						ticket_hash: "b".repeat(64),
						expires_at: new Date().toISOString(),
					})
					.execute(),
			).rejects.toThrow(/check|violates/i);
		},
	);

	test.skipIf(!hasTestDb())(
		"deleting the workspace removes its preview sessions",
		async () => {
			const userId = await insertTestUser(t.db);
			const ws = await t.db
				.insertInto("workspaces")
				.values({ label: "tw7", owner_user_id: userId, state: "running" })
				.returning("id")
				.executeTakeFirstOrThrow();
			await t.db
				.insertInto("sessions")
				.values({
					id: "session-hash",
					user_id: userId,
					expires_at: new Date(Date.now() + 60_000).toISOString(),
				})
				.execute();
			await t.db
				.insertInto("preview_sessions")
				.values({
					token_hash: "c".repeat(64),
					user_id: userId,
					session_id: "session-hash",
					workspace_id: ws.id,
					port: 5173,
					preview_host: "tw7-5173.preview.localhost",
				})
				.execute();

			await t.db.deleteFrom("workspaces").where("id", "=", ws.id).execute();

			const left = await t.db.selectFrom("preview_sessions").selectAll().execute();
			expect(left).toHaveLength(0);
		},
	);

	test.skipIf(!hasTestDb())(
		"ending the main session ends the preview session with it",
		async () => {
			const userId = await insertTestUser(t.db);
			const ws = await t.db
				.insertInto("workspaces")
				.values({ label: "tw7", owner_user_id: userId, state: "running" })
				.returning("id")
				.executeTakeFirstOrThrow();
			await t.db
				.insertInto("sessions")
				.values({
					id: "session-hash",
					user_id: userId,
					expires_at: new Date(Date.now() + 60_000).toISOString(),
				})
				.execute();
			await t.db
				.insertInto("preview_sessions")
				.values({
					token_hash: "d".repeat(64),
					user_id: userId,
					session_id: "session-hash",
					workspace_id: ws.id,
					port: 5173,
					preview_host: "tw7-5173.preview.localhost",
				})
				.execute();

			await t.db.deleteFrom("sessions").where("id", "=", "session-hash").execute();

			const left = await t.db.selectFrom("preview_sessions").selectAll().execute();
			expect(left).toHaveLength(0);
		},
	);

	// --- migration 0013: recovery points and maintenance operations ---
	// SPEC.md sections 15, 16.4, 17.2; ADR 0020 and 0021.

	async function insertProject(): Promise<{ workspaceId: string; projectId: string }> {
		const userId = await insertTestUser(t.db);
		const ws = await t.db
			.insertInto("workspaces")
			.values({ label: testLabel(), owner_user_id: userId, state: "running" })
			.returning("id")
			.executeTakeFirstOrThrow();
		const project = await t.db
			.insertInto("projects")
			.values({
				workspace_id: ws.id,
				slug: "demo",
				name: "Demo",
				path: "/home/student/projects/demo",
				source: "new",
			})
			.returning("id")
			.executeTakeFirstOrThrow();
		return { workspaceId: ws.id, projectId: project.id };
	}

	function pointValues(workspaceId: string, projectId: string, reason = "periodic") {
		return {
			id: crypto.randomUUID(),
			project_id: projectId,
			workspace_id: workspaceId,
			reason,
			created_by: "worker",
			size_bytes: 1234,
			sha256: "a".repeat(64),
			fingerprint: "f".repeat(64),
			expires_at: new Date(Date.now() + 86_400_000).toISOString(),
		};
	}

	test.skipIf(!hasTestDb())(
		"deleting a project removes its recovery points and clears the terminal link",
		async () => {
			const { workspaceId, projectId } = await insertProject();
			const point = pointValues(workspaceId, projectId, "agent-session");
			await t.db.insertInto("recovery_points").values(point).execute();
			const terminal = await t.db
				.insertInto("terminals")
				.values({
					workspace_id: workspaceId,
					name: "claude",
					cwd: "/home/student",
					recovery_point_id: point.id,
				})
				.returning("id")
				.executeTakeFirstOrThrow();

			const stored = await t.db
				.selectFrom("recovery_points")
				.selectAll()
				.executeTakeFirstOrThrow();
			expect(stored.size_bytes).toBe("1234");

			await t.db.deleteFrom("projects").where("id", "=", projectId).execute();

			const left = await t.db.selectFrom("recovery_points").selectAll().execute();
			expect(left).toHaveLength(0);
			const row = await t.db
				.selectFrom("terminals")
				.select("recovery_point_id")
				.where("id", "=", terminal.id)
				.executeTakeFirstOrThrow();
			expect(row.recovery_point_id).toBeNull();
		},
	);

	test.skipIf(!hasTestDb())("a recovery point rejects an unknown reason", async () => {
		const { workspaceId, projectId } = await insertProject();
		await expect(
			t.db
				.insertInto("recovery_points")
				.values(pointValues(workspaceId, projectId, "hourly"))
				.execute(),
		).rejects.toThrow(/check|violates/i);
	});

	test.skipIf(!hasTestDb())("recovery points are indexed by workspace", async () => {
		const { rows } = await sql<{ indexdef: string }>`
			SELECT indexdef FROM pg_indexes
			WHERE tablename = 'recovery_points' AND indexname = 'recovery_points_workspace_idx'
		`.execute(t.db);
		expect(rows[0]?.indexdef).toMatch(/\(workspace_id\)/);
	});

	test.skipIf(!hasTestDb())(
		"a workspace accepts only the three pending operations",
		async () => {
			const { workspaceId } = await insertProject();
			for (const op of ["reset-docker", "rebuild", "rebuild-reset-docker"]) {
				await t.db
					.updateTable("workspaces")
					.set({ pending_operation: op })
					.where("id", "=", workspaceId)
					.execute();
			}
			await expect(
				t.db
					.updateTable("workspaces")
					.set({ pending_operation: "reinstall" })
					.where("id", "=", workspaceId)
					.execute(),
			).rejects.toThrow(/check|violates/i);
		},
	);

	test.skipIf(!hasTestDb())(
		"migration 0013 adds recoveryGiB to quotas that lack it",
		async () => {
			const { Migrator } = await import("kysely/migration");
			const { migrations } = await import("./migrations/index.js");
			const rollback = new Error("rollback");
			const userId = await insertTestUser(t.db);

			await expect(
				t.db.transaction().execute(async (trx) => {
					const migrator = new Migrator({
						db: trx,
						provider: { getMigrations: async () => migrations },
					});
					// Down past 0024 and 0023 (Epic 21),
					expect((await migrator.migrateDown()).error).toBeUndefined();
					// 0021 and 0020 (Epic 14.3), 0019 (Epic 14.2), 0018 (Epic 14), 0017 and 0016 (Epic 13.1), 0015 (Epic 13) and 0014 (Epic 11), then 0013.
					expect((await migrator.migrateDown()).error).toBeUndefined();
					expect((await migrator.migrateDown()).error).toBeUndefined();
					expect((await migrator.migrateDown()).error).toBeUndefined();
					expect((await migrator.migrateDown()).error).toBeUndefined();
					expect((await migrator.migrateDown()).error).toBeUndefined();
					expect((await migrator.migrateDown()).error).toBeUndefined();
					expect((await migrator.migrateDown()).error).toBeUndefined();
					expect((await migrator.migrateDown()).error).toBeUndefined();
					expect((await migrator.migrateDown()).error).toBeUndefined();
					expect((await migrator.migrateDown()).error).toBeUndefined();
					await trx
						.insertInto("workspaces")
						.values({
							label: testLabel(),
							owner_user_id: userId,
							state: "stopped",
							quota_config: JSON.stringify({ homeGiB: 25, dockerGiB: 20 }),
						})
						.execute();
					expect((await migrator.migrateToLatest()).error).toBeUndefined();
					const row = await trx
						.selectFrom("workspaces")
						.select("quota_config")
						.executeTakeFirstOrThrow();
					expect(row.quota_config).toEqual({
						homeGiB: 25,
						dockerGiB: 20,
						recoveryGiB: 3,
					});
					throw rollback;
				}),
			).rejects.toBe(rollback);
		},
	);
});

describe("orphaned test database sweep", () => {
	test.skipIf(!hasTestDb())(
		"drops this host's dead orphans but leaves another host's alone",
		async () => {
			const sharedUrl = process.env.TEST_DATABASE_URL as string;
			const base = basePrefix(new URL(sharedUrl));
			// A dead pid: 999999 does not belong to a running process.
			const otherHostDb = `${base}_hffff_p999999_deadbeef`;
			const thisHostDb = `${base}_h${hostId()}_p999999_deadbeef`;

			const client = new pg.Client({ connectionString: sharedUrl });
			await client.connect();
			try {
				await client.query(`DROP DATABASE IF EXISTS "${otherHostDb}" WITH (FORCE)`);
				await client.query(`CREATE DATABASE "${otherHostDb}"`);
				await client.query(`DROP DATABASE IF EXISTS "${thisHostDb}" WITH (FORCE)`);
				await client.query(`CREATE DATABASE "${thisHostDb}"`);

				// Creating a database runs the sweep as a side effect.
				const swept = await createTestDb();
				await swept.close();

				const { rows } = await client.query<{ datname: string }>(
					"SELECT datname FROM pg_database WHERE datname = $1 OR datname = $2",
					[otherHostDb, thisHostDb],
				);
				const names = rows.map((r) => r.datname);
				expect(names).toContain(otherHostDb);
				expect(names).not.toContain(thisHostDb);
			} finally {
				await client
					.query(`DROP DATABASE IF EXISTS "${otherHostDb}" WITH (FORCE)`)
					.catch(() => {});
				await client.end();
			}
		},
	);
});

// --- migration 0020: resource guard and acceptable use (ADR 0032) ---

describe("resource guard migration", () => {
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

	test.skipIf(!hasTestDb())(
		"0023 adds the idle-lift settings with their defaults and bounds, and rolls back",
		async () => {
			const { Migrator } = await import("kysely/migration");
			const { migrations } = await import("./migrations/index.js");
			const rollback = new Error("rollback");
			const columns = sql<{ n: number }>`
				select count(*)::int as n from information_schema.columns
				where table_name = 'settings'
				and column_name in ('cpu_idle_lift_minutes', 'cpu_idle_lift_percent')`;

			await expect(
				t.db.transaction().execute(async (trx) => {
					await sql`insert into settings (id, shutdown_grace_seconds) values (1, 600)`.execute(
						trx,
					);
					const row = await trx
						.selectFrom("settings")
						.select(["cpu_idle_lift_minutes", "cpu_idle_lift_percent"])
						.executeTakeFirstOrThrow();
					expect(row).toEqual({ cpu_idle_lift_minutes: 5, cpu_idle_lift_percent: 10 });
					await trx
						.updateTable("settings")
						.set({ cpu_idle_lift_minutes: 60, cpu_idle_lift_percent: 0 })
						.execute();
					for (const bad of [
						{ cpu_idle_lift_minutes: 0 },
						{ cpu_idle_lift_minutes: 61 },
						{ cpu_idle_lift_percent: -1 },
						{ cpu_idle_lift_percent: 101 },
					]) {
						await sql`savepoint bad`.execute(trx);
						await expect(
							trx.updateTable("settings").set(bad).execute(),
						).rejects.toThrow(/check constraint/);
						await sql`rollback to savepoint bad`.execute(trx);
					}

					const migrator = new Migrator({
						db: trx,
						provider: { getMigrations: async () => migrations },
					});
					expect((await migrator.migrateDown()).error).toBeUndefined();
					const down = await migrator.migrateDown();
					expect(down.error).toBeUndefined();
					expect(down.results?.[0]?.migrationName).toBe("0023_guard_idle_lift");
					expect((await columns.execute(trx)).rows[0]?.n).toBe(0);
					const up = await migrator.migrateToLatest();
					expect(up.error).toBeUndefined();
					expect((await columns.execute(trx)).rows[0]?.n).toBe(2);
					throw rollback;
				}),
			).rejects.toBe(rollback);
		},
	);

	test.skipIf(!hasTestDb())(
		"0020 fills settings defaults, gives grace-0 owners an idle override of 0, and rolls back",
		async () => {
			const { Migrator } = await import("kysely/migration");
			const { migrations } = await import("./migrations/index.js");
			const rollback = new Error("rollback");

			await expect(
				t.db.transaction().execute(async (trx) => {
					const migrator = new Migrator({
						db: trx,
						provider: { getMigrations: async () => migrations },
					});
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0024_process_snapshots",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0023_guard_idle_lift",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0021_notifications",
					);
					const down = await migrator.migrateDown();
					expect(down.error).toBeUndefined();
					expect(down.results?.[0]?.migrationName).toBe("0020_resource_guard");
					const gone = await sql<{ n: number }>`
					select count(*)::int as n from information_schema.columns
					where column_name in ('cpu_guard_threshold_percent', 'guard_config',
						'acceptable_use_version', 'idle_stop_at', 'last_activity_at')
					or table_name = 'workspace_usage_samples'`.execute(trx);
					expect(gone.rows[0]?.n).toBe(0);

					await sql`insert into settings (id, shutdown_grace_seconds) values (1, 600)`.execute(
						trx,
					);
					const optedOut = await insertTestUser(trx, { shutdown_grace_seconds: 0 });
					const longGrace = await insertTestUser(trx, { shutdown_grace_seconds: 3600 });
					const plain = await insertTestUser(trx);
					for (const owner of [optedOut, longGrace, plain]) {
						await trx
							.insertInto("workspaces")
							.values({ label: testLabel(), owner_user_id: owner, state: "stopped" })
							.execute();
					}
					const runner = await insertTestUser(trx);
					await trx
						.insertInto("workspaces")
						.values({ label: testLabel(), owner_user_id: runner, state: "running" })
						.execute();
					const stopper = await insertTestUser(trx);
					await trx
						.insertInto("workspaces")
						.values({ label: testLabel(), owner_user_id: stopper, state: "stopping" })
						.execute();

					const up = await migrator.migrateToLatest();
					expect(up.error).toBeUndefined();

					const settings = await trx
						.selectFrom("settings")
						.selectAll()
						.executeTakeFirstOrThrow();
					expect(settings).toMatchObject({
						cpu_guard_threshold_percent: 80,
						memory_guard_threshold_percent: 90,
						guard_window_minutes: 30,
						cpu_throttle_share_percent: 25,
						idle_stop_minutes: 60,
						acceptable_use_text: null,
						acceptable_use_version: 1,
					});

					const rows = await trx
						.selectFrom("workspaces")
						.select([
							"owner_user_id",
							"guard_config",
							"cpu_throttle",
							"memory_flag",
							"last_activity_at",
							"idle_stop_at",
						])
						.execute();
					const byOwner = new Map(rows.map((r) => [r.owner_user_id, r]));
					expect(byOwner.get(optedOut)?.guard_config).toEqual({ idleStopMinutes: 0 });
					expect(byOwner.get(longGrace)?.guard_config).toBeNull();
					expect(byOwner.get(plain)?.guard_config).toBeNull();
					// Every workspace not stopped counts as active from the migration on,
					// so a stopping one whose stop fails can still idle-stop later.
					expect(byOwner.get(runner)?.last_activity_at).toBeInstanceOf(Date);
					expect(byOwner.get(stopper)?.last_activity_at).toBeInstanceOf(Date);
					for (const r of rows) {
						expect(r.cpu_throttle).toBeNull();
						expect(r.memory_flag).toBeNull();
						if (r.owner_user_id !== runner && r.owner_user_id !== stopper)
							expect(r.last_activity_at).toBeNull();
						expect(r.idle_stop_at).toBeNull();
					}

					const user = await trx
						.selectFrom("users")
						.select(["acceptable_use_version", "acceptable_use_accepted_at"])
						.where("id", "=", plain)
						.executeTakeFirstOrThrow();
					expect(user).toEqual({
						acceptable_use_version: null,
						acceptable_use_accepted_at: null,
					});
					throw rollback;
				}),
			).rejects.toBe(rollback);
		},
	);

	test.skipIf(!hasTestDb())(
		"0020's backfill keeps other guard keys already set",
		async () => {
			// The column is new in 0020, so no row can hold keys before it runs;
			// this pins the backfill statement for a row that already has some.
			const { backfillIdleOverride } = await import(
				"./migrations/0020_resource_guard.js"
			);
			const owner = await insertTestUser(t.db, { shutdown_grace_seconds: 0 });
			await t.db
				.insertInto("workspaces")
				.values({
					label: testLabel(),
					owner_user_id: owner,
					state: "stopped",
					guard_config: JSON.stringify({
						cpuThresholdPercent: 95,
						idleStopMinutes: 30,
					}),
				})
				.execute();
			await backfillIdleOverride(t.db as Kysely<unknown>);
			const row = await t.db
				.selectFrom("workspaces")
				.select("guard_config")
				.where("owner_user_id", "=", owner)
				.executeTakeFirstOrThrow();
			expect(row.guard_config).toEqual({ cpuThresholdPercent: 95, idleStopMinutes: 0 });
		},
	);

	test.skipIf(!hasTestDb())("settings refuse guard values out of range", async () => {
		await t.db
			.insertInto("settings")
			.values({ id: 1, shutdown_grace_seconds: 600 })
			.execute();
		const bad: Array<[string, number]> = [
			["cpu_guard_threshold_percent", 0],
			["cpu_guard_threshold_percent", 101],
			["memory_guard_threshold_percent", 0],
			["memory_guard_threshold_percent", 101],
			["guard_window_minutes", 4],
			["guard_window_minutes", 241],
			["cpu_throttle_share_percent", 4],
			["cpu_throttle_share_percent", 101],
			["idle_stop_minutes", -1],
			["idle_stop_minutes", 9],
			["idle_stop_minutes", 1441],
		];
		for (const [column, value] of bad) {
			await expect(
				t.db
					.updateTable("settings")
					.set({ [column]: value })
					.execute(),
				`${column} = ${value}`,
			).rejects.toThrow(new RegExp(`settings_${column}_check`));
		}
		const good: Array<[string, number]> = [
			["cpu_guard_threshold_percent", 1],
			["cpu_guard_threshold_percent", 100],
			["memory_guard_threshold_percent", 100],
			["guard_window_minutes", 5],
			["guard_window_minutes", 240],
			["cpu_throttle_share_percent", 5],
			["cpu_throttle_share_percent", 100],
			["idle_stop_minutes", 0],
			["idle_stop_minutes", 10],
			["idle_stop_minutes", 1440],
		];
		for (const [column, value] of good) {
			await t.db
				.updateTable("settings")
				.set({ [column]: value })
				.execute();
		}
	});

	test.skipIf(!hasTestDb())(
		"workspace_usage_samples stores a reading and goes with its workspace",
		async () => {
			const owner = await insertTestUser(t.db);
			const ws = await t.db
				.insertInto("workspaces")
				.values({ label: testLabel(), owner_user_id: owner, state: "running" })
				.returning("id")
				.executeTakeFirstOrThrow();
			const row = await t.db
				.insertInto("workspace_usage_samples")
				.values({
					workspace_id: ws.id,
					observed_at: new Date().toISOString(),
					cpu_usage_ns: "9007199254740993",
					cpu_limit: 4,
					memory_bytes: 1024,
					memory_limit_bytes: 6 * 1024 ** 3,
				})
				.returningAll()
				.executeTakeFirstOrThrow();
			expect(row.cpu_usage_ns).toBe("9007199254740993");
			expect(row.memory_limit_bytes).toBe(String(6 * 1024 ** 3));

			const { rows } = await sql<{ indexdef: string }>`
				select indexdef from pg_indexes
				where tablename = 'workspace_usage_samples'
				and indexname = 'workspace_usage_samples_workspace_observed_idx'`.execute(t.db);
			expect(rows[0]?.indexdef).toMatch(/\(workspace_id, observed_at\)/);

			await t.db.deleteFrom("workspaces").where("id", "=", ws.id).execute();
			const left = await t.db
				.selectFrom("workspace_usage_samples")
				.select("id")
				.where("workspace_id", "=", ws.id)
				.execute();
			expect(left).toEqual([]);
		},
	);

	test.skipIf(!hasTestDb())(
		"Epic 14.2's 0019 applies after 0020 and orders before it on a fresh run",
		async () => {
			const { migrateToLatest } = await import("./migrate.js");
			const { Migrator } = await import("kysely/migration");
			const { migrations } = await import("./migrations/index.js");
			const { "0019_local_admin": _late, ...without0019 } = migrations;
			const rollback = new Error("rollback");

			await expect(
				t.db.transaction().execute(async (trx) => {
					const migrator = new Migrator({
						db: trx,
						provider: { getMigrations: async () => migrations },
						allowUnorderedMigrations: true,
					});
					// Build a database that took 0020, 0021, 0023 and 0024 before 0019 existed.
					expect((await migrator.migrateDown()).error).toBeUndefined();
					expect((await migrator.migrateDown()).error).toBeUndefined();
					expect((await migrator.migrateDown()).error).toBeUndefined();
					expect((await migrator.migrateDown()).error).toBeUndefined();
					expect((await migrator.migrateDown()).error).toBeUndefined();
					expect(await migrateToLatest(trx, without0019)).toEqual([
						"0020_resource_guard",
						"0021_notifications",
						"0023_guard_idle_lift",
						"0024_process_snapshots",
					]);
					// It takes 0019 when it arrives.
					expect(await migrateToLatest(trx, migrations)).toEqual(["0019_local_admin"]);
					// Undo 0019, 0024, 0023, 0021, 0020 and 0018 (applied 0018, 0020, 0021, 0023, 0024, 0019).
					expect((await migrator.migrateDown()).error).toBeUndefined();
					expect((await migrator.migrateDown()).error).toBeUndefined();
					expect((await migrator.migrateDown()).error).toBeUndefined();
					expect((await migrator.migrateDown()).error).toBeUndefined();
					expect((await migrator.migrateDown()).error).toBeUndefined();
					expect((await migrator.migrateDown()).error).toBeUndefined();
					// A fresh run applies them by name.
					const up = await migrator.migrateToLatest();
					expect(up.error).toBeUndefined();
					expect(up.results?.map((r) => r.migrationName)).toEqual([
						"0018_setup_codes",
						"0019_local_admin",
						"0020_resource_guard",
						"0021_notifications",
						"0023_guard_idle_lift",
						"0024_process_snapshots",
					]);
					throw rollback;
				}),
			).rejects.toBe(rollback);
		},
	);
	test.skipIf(!hasTestDb())(
		"0024 adds the process snapshot table, cascades with the workspace, and rolls back",
		async () => {
			const { Migrator } = await import("kysely/migration");
			const { migrations } = await import("./migrations/index.js");
			const rollback = new Error("rollback");
			const table = sql<{ n: number }>`
				select count(*)::int as n from information_schema.tables
				where table_name = 'workspace_process_snapshots'`;

			await expect(
				t.db.transaction().execute(async (trx) => {
					const owner = await insertTestUser(trx);
					const ws = await trx
						.insertInto("workspaces")
						.values({ label: testLabel(), owner_user_id: owner, state: "running" })
						.returning("id")
						.executeTakeFirstOrThrow();
					await trx
						.insertInto("workspace_process_snapshots")
						.values({
							workspace_id: ws.id,
							requested_at: new Date().toISOString(),
							requested_by: owner,
						})
						.execute();
					await trx.deleteFrom("workspaces").where("id", "=", ws.id).execute();
					const left = await trx
						.selectFrom("workspace_process_snapshots")
						.select("workspace_id")
						.execute();
					expect(left).toEqual([]);

					const migrator = new Migrator({
						db: trx,
						provider: { getMigrations: async () => migrations },
					});
					const down = await migrator.migrateDown();
					expect(down.results?.[0]?.migrationName).toBe("0024_process_snapshots");
					expect((await table.execute(trx)).rows[0]?.n).toBe(0);
					expect((await migrator.migrateToLatest()).error).toBeUndefined();
					expect((await table.execute(trx)).rows[0]?.n).toBe(1);
					throw rollback;
				}),
			).rejects.toBe(rollback);
		},
	);
});
