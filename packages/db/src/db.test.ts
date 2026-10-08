import type { PendingOperation, WorkspaceState } from "@portikus/contracts";
import { type Kysely, sql } from "kysely";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import {
	createDb,
	createPool,
	isDatabaseUnavailable,
	isPoolTimeout,
	poolOptions,
} from "./index.js";
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
					// Past the type on purpose: the CHECK constraint is under test.
					state: "flying" as WorkspaceState,
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

	// --- migration 0010: the terminal's own colour scheme ---

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
				// Past 0031 first.
				expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
					"0040_signin_counters",
				);
				expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
					"0039_notification_flags",
				);
				expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
					"0038_account_invitations",
				);
				expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
					"0037_second_factor",
				);
				expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
					"0036_start_retries_and_controller_check",
				);
				expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
					"0035_docker_seed_images_set",
				);
				expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
					"0034_keep_running",
				);
				expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
					"0033_ghcr_default_on",
				);
				expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
					"0032_docker_pull_days",
				);
				expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
					"0031_docker_cache",
				);
				// Past 0030 and 0029 first.
				expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
					"0030_egress_blocked_sites",
				);
				expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
					"0029_package_survey",
				);
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
				const down24 = await migrator.migrateDown();
				expect(down24.error).toBeUndefined();
				const down26 = await migrator.migrateDown();
				expect(down26.error).toBeUndefined();
				const down28 = await migrator.migrateDown();
				expect(down28.error).toBeUndefined();
				const down27 = await migrator.migrateDown();
				expect(down27.error).toBeUndefined();
				const down25 = await migrator.migrateDown();
				expect(down25.error).toBeUndefined();
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
					"0022_api_request_samples",
					"0023_guard_idle_lift",
					"0024_process_snapshots",
					"0025_egress",
					"0026_backups",
					"0027_workspace_limits",
					"0028_throttle_hold",
					"0029_package_survey",
					"0030_egress_blocked_sites",
					"0031_docker_cache",
					"0032_docker_pull_days",
					"0033_ghcr_default_on",
					"0034_keep_running",
					"0035_docker_seed_images_set",
					"0036_start_retries_and_controller_check",
					"0037_second_factor",
					"0038_account_invitations",
					"0039_notification_flags",
					"0040_signin_counters",
				]);
				throw rollback;
			}),
		).rejects.toBe(rollback);
	});

	// --- migration 0016: account links and the role grant ---

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
					// Past 0031 first.
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0040_signin_counters",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0039_notification_flags",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0038_account_invitations",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0037_second_factor",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0036_start_retries_and_controller_check",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0035_docker_seed_images_set",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0034_keep_running",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0033_ghcr_default_on",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0032_docker_pull_days",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0031_docker_cache",
					);
					// Past 0030 and 0029 first.
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0030_egress_blocked_sites",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0029_package_survey",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0028_throttle_hold",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0027_workspace_limits",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0026_backups",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0025_egress",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0024_process_snapshots",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0023_guard_idle_lift",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0022_api_request_samples",
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

	// --- migration 0019: the local administrator ---

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
					// Past 0031 first.
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0040_signin_counters",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0039_notification_flags",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0038_account_invitations",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0037_second_factor",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0036_start_retries_and_controller_check",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0035_docker_seed_images_set",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0034_keep_running",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0033_ghcr_default_on",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0032_docker_pull_days",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0031_docker_cache",
					);
					// Past 0030 and 0029 first.
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0030_egress_blocked_sites",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0029_package_survey",
					);
					// Past 0028, 0027, 0026, 0025, 0024, 0023, 0022, 0021 and 0020 first.
					expect((await migrator.migrateDown()).error).toBeUndefined();
					expect((await migrator.migrateDown()).error).toBeUndefined();
					expect((await migrator.migrateDown()).error).toBeUndefined();
					expect((await migrator.migrateDown()).error).toBeUndefined();
					expect((await migrator.migrateDown()).error).toBeUndefined();
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

	// --- migration 0017: session method and the link's archive stamp ---

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
					// Past 0031 first.
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0040_signin_counters",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0039_notification_flags",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0038_account_invitations",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0037_second_factor",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0036_start_retries_and_controller_check",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0035_docker_seed_images_set",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0034_keep_running",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0033_ghcr_default_on",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0032_docker_pull_days",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0031_docker_cache",
					);
					// Past 0030 and 0029 first.
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0030_egress_blocked_sites",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0029_package_survey",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0028_throttle_hold",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0027_workspace_limits",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0026_backups",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0025_egress",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0024_process_snapshots",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0023_guard_idle_lift",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0022_api_request_samples",
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

	// --- migration 0015: LTI launch and the instructor role ---

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
					// Past 0031 first.
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0040_signin_counters",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0039_notification_flags",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0038_account_invitations",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0037_second_factor",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0036_start_retries_and_controller_check",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0035_docker_seed_images_set",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0034_keep_running",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0033_ghcr_default_on",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0032_docker_pull_days",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0031_docker_cache",
					);
					// Past 0030 and 0029 first.
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0030_egress_blocked_sites",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0029_package_survey",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0028_throttle_hold",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0027_workspace_limits",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0026_backups",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0025_egress",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0024_process_snapshots",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0023_guard_idle_lift",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0022_api_request_samples",
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

	// --- migration 0014: admin columns, health samples, audit indexes ---

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
					// Past 0031 first.
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0040_signin_counters",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0039_notification_flags",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0038_account_invitations",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0037_second_factor",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0036_start_retries_and_controller_check",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0035_docker_seed_images_set",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0034_keep_running",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0033_ghcr_default_on",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0032_docker_pull_days",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0031_docker_cache",
					);
					// Past 0030 and 0029 first.
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0030_egress_blocked_sites",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0029_package_survey",
					);
					await migrator.migrateDown();
					await migrator.migrateDown();
					await migrator.migrateDown();
					await migrator.migrateDown();
					await migrator.migrateDown();
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

			// Stands in for 0013 landing after 0014 is already applied.
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
	// SPEC.md section 14.3; BROWSER-HANDLING.md sections 8 and 17.

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
			for (const op of ["reset-docker", "rebuild", "rebuild-reset-docker"] as const) {
				await t.db
					.updateTable("workspaces")
					.set({ pending_operation: op })
					.where("id", "=", workspaceId)
					.execute();
			}
			await expect(
				t.db
					.updateTable("workspaces")
					// Past the type on purpose: the CHECK constraint is under test.
					.set({ pending_operation: "reinstall" as PendingOperation })
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
					// Past 0031 first.
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0040_signin_counters",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0039_notification_flags",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0038_account_invitations",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0037_second_factor",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0036_start_retries_and_controller_check",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0035_docker_seed_images_set",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0034_keep_running",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0033_ghcr_default_on",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0032_docker_pull_days",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0031_docker_cache",
					);
					// Past 0030 and 0029 first.
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0030_egress_blocked_sites",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0029_package_survey",
					);
					// Down past 0028, 0027, 0026, 0025, 0024 and 0023, 0022,
					expect((await migrator.migrateDown()).error).toBeUndefined();
					expect((await migrator.migrateDown()).error).toBeUndefined();
					expect((await migrator.migrateDown()).error).toBeUndefined();
					expect((await migrator.migrateDown()).error).toBeUndefined();
					expect((await migrator.migrateDown()).error).toBeUndefined();
					// 0021 and 0020, 0019, 0018, 0017 and 0016, 0015 and 0014, then 0013.
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
					// Past 0031 first.
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0040_signin_counters",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0039_notification_flags",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0038_account_invitations",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0037_second_factor",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0036_start_retries_and_controller_check",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0035_docker_seed_images_set",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0034_keep_running",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0033_ghcr_default_on",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0032_docker_pull_days",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0031_docker_cache",
					);
					// Past 0030 and 0029 first.
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0030_egress_blocked_sites",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0029_package_survey",
					);
					expect((await migrator.migrateDown()).error).toBeUndefined();
					expect((await migrator.migrateDown()).error).toBeUndefined();
					expect((await migrator.migrateDown()).error).toBeUndefined();
					expect((await migrator.migrateDown()).error).toBeUndefined();
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
					// Past 0031 first.
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0040_signin_counters",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0039_notification_flags",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0038_account_invitations",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0037_second_factor",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0036_start_retries_and_controller_check",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0035_docker_seed_images_set",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0034_keep_running",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0033_ghcr_default_on",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0032_docker_pull_days",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0031_docker_cache",
					);
					// Past 0030 and 0029 first.
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0030_egress_blocked_sites",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0029_package_survey",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0028_throttle_hold",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0027_workspace_limits",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0026_backups",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0025_egress",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0024_process_snapshots",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0023_guard_idle_lift",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0022_api_request_samples",
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
			["keep_running_max_hours", -1],
			["keep_running_max_hours", 169],
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
			["keep_running_max_hours", 0],
			["keep_running_max_hours", 168],
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
					// Past 0031 first.
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0040_signin_counters",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0039_notification_flags",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0038_account_invitations",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0037_second_factor",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0036_start_retries_and_controller_check",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0035_docker_seed_images_set",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0034_keep_running",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0033_ghcr_default_on",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0032_docker_pull_days",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0031_docker_cache",
					);
					// Past 0030 and 0029 first.
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0030_egress_blocked_sites",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0029_package_survey",
					);
					// Build a database that took 0020 to 0028 before 0019 existed.
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
					expect(await migrateToLatest(trx, without0019)).toEqual([
						"0020_resource_guard",
						"0021_notifications",
						"0022_api_request_samples",
						"0023_guard_idle_lift",
						"0024_process_snapshots",
						"0025_egress",
						"0026_backups",
						"0027_workspace_limits",
						"0028_throttle_hold",
						"0029_package_survey",
						"0030_egress_blocked_sites",
						"0031_docker_cache",
						"0032_docker_pull_days",
						"0033_ghcr_default_on",
						"0034_keep_running",
						"0035_docker_seed_images_set",
						"0036_start_retries_and_controller_check",
						"0037_second_factor",
						"0038_account_invitations",
						"0039_notification_flags",
						"0040_signin_counters",
					]);
					// It takes 0019 when it arrives.
					expect(await migrateToLatest(trx, migrations)).toEqual(["0019_local_admin"]);
					// Undo 0019, 0040 down to 0020, and 0018 (applied 0018, 0020 to 0040, 0019).
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
						"0022_api_request_samples",
						"0023_guard_idle_lift",
						"0024_process_snapshots",
						"0025_egress",
						"0026_backups",
						"0027_workspace_limits",
						"0028_throttle_hold",
						"0029_package_survey",
						"0030_egress_blocked_sites",
						"0031_docker_cache",
						"0032_docker_pull_days",
						"0033_ghcr_default_on",
						"0034_keep_running",
						"0035_docker_seed_images_set",
						"0036_start_retries_and_controller_check",
						"0037_second_factor",
						"0038_account_invitations",
						"0039_notification_flags",
						"0040_signin_counters",
					]);
					throw rollback;
				}),
			).rejects.toBe(rollback);
		},
	);
	test.skipIf(!hasTestDb())(
		"0027 adds the nullable limits columns and rolls back",
		async () => {
			const { Migrator } = await import("kysely/migration");
			const { migrations } = await import("./migrations/index.js");
			const rollback = new Error("rollback");
			const columns = sql<{ n: number }>`
				select count(*)::int as n from information_schema.columns
				where table_name = 'workspaces'
				and column_name in ('limits_config', 'limits_applied')`;

			await expect(
				t.db.transaction().execute(async (trx) => {
					const owner = await insertTestUser(trx);
					const ws = await trx
						.insertInto("workspaces")
						.values({ label: testLabel(), owner_user_id: owner, state: "stopped" })
						.returning(["limits_config", "limits_applied"])
						.executeTakeFirstOrThrow();
					expect(ws).toEqual({ limits_config: null, limits_applied: null });
					expect((await columns.execute(trx)).rows[0]?.n).toBe(2);

					const migrator = new Migrator({
						db: trx,
						provider: { getMigrations: async () => migrations },
					});
					// Past 0031 first.
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0040_signin_counters",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0039_notification_flags",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0038_account_invitations",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0037_second_factor",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0036_start_retries_and_controller_check",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0035_docker_seed_images_set",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0034_keep_running",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0033_ghcr_default_on",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0032_docker_pull_days",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0031_docker_cache",
					);
					// Past 0030, 0029 and 0028 first.
					expect((await migrator.migrateDown()).error).toBeUndefined();
					expect((await migrator.migrateDown()).error).toBeUndefined();
					expect((await migrator.migrateDown()).error).toBeUndefined();
					const down = await migrator.migrateDown();
					expect(down.results?.[0]?.migrationName).toBe("0027_workspace_limits");
					expect((await columns.execute(trx)).rows[0]?.n).toBe(0);
					expect((await migrator.migrateToLatest()).error).toBeUndefined();
					expect((await columns.execute(trx)).rows[0]?.n).toBe(2);
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
					// Past 0031 first.
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0040_signin_counters",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0039_notification_flags",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0038_account_invitations",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0037_second_factor",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0036_start_retries_and_controller_check",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0035_docker_seed_images_set",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0034_keep_running",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0033_ghcr_default_on",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0032_docker_pull_days",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0031_docker_cache",
					);
					// Past 0030 and 0029 first.
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0030_egress_blocked_sites",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0029_package_survey",
					);
					expect((await migrator.migrateDown()).error).toBeUndefined();
					expect((await migrator.migrateDown()).error).toBeUndefined();
					expect((await migrator.migrateDown()).error).toBeUndefined();
					expect((await migrator.migrateDown()).error).toBeUndefined();
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
	test.skipIf(!hasTestDb())(
		"0029 adds the package survey tables and the surveyed date, and rolls back",
		async () => {
			const { Migrator } = await import("kysely/migration");
			const { migrations } = await import("./migrations/index.js");
			const rollback = new Error("rollback");
			const objects = sql<{ n: number }>`
				select (select count(*) from information_schema.tables
					where table_name in ('package_survey_days', 'package_survey_counts'))
				+ (select count(*) from information_schema.columns
					where table_name = 'workspaces' and column_name = 'package_surveyed_on')
				as n`;

			await expect(
				t.db.transaction().execute(async (trx) => {
					expect(Number((await objects.execute(trx)).rows[0]?.n)).toBe(3);
					const migrator = new Migrator({
						db: trx,
						provider: { getMigrations: async () => migrations },
					});
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0040_signin_counters",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0039_notification_flags",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0038_account_invitations",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0037_second_factor",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0036_start_retries_and_controller_check",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0035_docker_seed_images_set",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0034_keep_running",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0033_ghcr_default_on",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0032_docker_pull_days",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0031_docker_cache",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0030_egress_blocked_sites",
					);
					const down = await migrator.migrateDown();
					expect(down.results?.[0]?.migrationName).toBe("0029_package_survey");
					expect(Number((await objects.execute(trx)).rows[0]?.n)).toBe(0);
					expect((await migrator.migrateToLatest()).error).toBeUndefined();
					expect(Number((await objects.execute(trx)).rows[0]?.n)).toBe(3);
					throw rollback;
				}),
			).rejects.toBe(rollback);
		},
	);
	test.skipIf(!hasTestDb())(
		"0030 adds an empty blocked sites table with unique names, and rolls back",
		async () => {
			const { Migrator } = await import("kysely/migration");
			const { migrations } = await import("./migrations/index.js");
			const rollback = new Error("rollback");
			const table = sql<{ n: number }>`
				select count(*)::int as n from information_schema.tables
				where table_name = 'egress_blocked_entries'`;

			await expect(
				t.db.transaction().execute(async (trx) => {
					const migrator = new Migrator({
						db: trx,
						provider: { getMigrations: async () => migrations },
					});
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0040_signin_counters",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0039_notification_flags",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0038_account_invitations",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0037_second_factor",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0036_start_retries_and_controller_check",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0035_docker_seed_images_set",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0034_keep_running",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0033_ghcr_default_on",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0032_docker_pull_days",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0031_docker_cache",
					);
					const down = await migrator.migrateDown();
					expect(down.results?.[0]?.migrationName).toBe("0030_egress_blocked_sites");
					expect((await table.execute(trx)).rows[0]?.n).toBe(0);
					expect((await migrator.migrateToLatest()).error).toBeUndefined();
					const rows = await trx
						.selectFrom("egress_blocked_entries")
						.select("value")
						.execute();
					// No seed: a non-empty list would put open mode behind Squid (ADR 0043).
					expect(rows).toEqual([]);
					await trx
						.insertInto("egress_blocked_entries")
						.values({ value: "dns.google", label: "" })
						.execute();
					await expect(
						trx
							.insertInto("egress_blocked_entries")
							.values({ value: "dns.google", label: "" })
							.execute(),
					).rejects.toMatchObject({ code: "23505" });
					throw rollback;
				}),
			).rejects.toBe(rollback);
		},
	);
	test.skipIf(!hasTestDb())(
		"0031 adds the Docker settings with defaults, one active seed job, and rolls back",
		async () => {
			const { Migrator } = await import("kysely/migration");
			const { migrations } = await import("./migrations/index.js");
			const rollback = new Error("rollback");
			const tables = sql<{ n: number }>`
				select count(*)::int as n from information_schema.tables
				where table_name in ('docker_seed', 'docker_seed_jobs',
					'docker_image_pulls', 'docker_image_presence')`;

			await expect(
				t.db.transaction().execute(async (trx) => {
					expect((await tables.execute(trx)).rows[0]?.n).toBe(4);
					await trx
						.insertInto("settings")
						.values({ id: 1, shutdown_grace_seconds: 600 })
						.onConflict((oc) => oc.doNothing())
						.execute();
					const s = await trx
						.selectFrom("settings")
						.select([
							"docker_ghcr_enabled",
							"docker_seed_max_gib",
							"docker_seed_images",
						])
						.executeTakeFirstOrThrow();
					expect(s).toEqual({
						docker_ghcr_enabled: true,
						docker_seed_max_gib: 8,
						docker_seed_images: [],
					});
					await trx
						.insertInto("docker_seed_jobs")
						.values({ images: JSON.stringify(["redis:7"]) })
						.execute();
					await expect(
						trx
							.insertInto("docker_seed_jobs")
							.values({ images: JSON.stringify(["redis:7"]) })
							.execute(),
					).rejects.toMatchObject({ code: "23505" });
					throw rollback;
				}),
			).rejects.toBe(rollback);

			await expect(
				t.db.transaction().execute(async (trx) => {
					const migrator = new Migrator({
						db: trx,
						provider: { getMigrations: async () => migrations },
					});
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0040_signin_counters",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0039_notification_flags",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0038_account_invitations",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0037_second_factor",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0036_start_retries_and_controller_check",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0035_docker_seed_images_set",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0034_keep_running",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0033_ghcr_default_on",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0032_docker_pull_days",
					);
					const down = await migrator.migrateDown();
					expect(down.results?.[0]?.migrationName).toBe("0031_docker_cache");
					expect((await tables.execute(trx)).rows[0]?.n).toBe(0);
					expect((await migrator.migrateToLatest()).error).toBeUndefined();
					throw rollback;
				}),
			).rejects.toBe(rollback);
		},
	);
	test.skipIf(!hasTestDb())(
		"0035 counts a seed list as set when it has images or was ever saved",
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
					const flag = async () =>
						(
							await sql<{ set: boolean }>`
								select docker_seed_images_set as set from settings`.execute(trx)
						).rows[0]?.set;
					await sql`delete from settings`.execute(trx);
					await sql`insert into settings (id, shutdown_grace_seconds) values (1, 600)`.execute(
						trx,
					);
					expect(await flag()).toBe(false);
					expect((await migrator.migrateDown()).error).toBeUndefined();
					expect((await migrator.migrateDown()).error).toBeUndefined();
					expect((await migrator.migrateDown()).error).toBeUndefined();
					expect((await migrator.migrateDown()).error).toBeUndefined();
					expect((await migrator.migrateDown()).error).toBeUndefined();
					expect((await migrator.migrateDown()).error).toBeUndefined();
					await sql`update settings set docker_seed_images = '["redis:7"]'`.execute(
						trx,
					);
					expect((await migrator.migrateToLatest()).error).toBeUndefined();
					expect(await flag()).toBe(true);
					expect((await migrator.migrateDown()).error).toBeUndefined();
					expect((await migrator.migrateDown()).error).toBeUndefined();
					expect((await migrator.migrateDown()).error).toBeUndefined();
					expect((await migrator.migrateDown()).error).toBeUndefined();
					expect((await migrator.migrateDown()).error).toBeUndefined();
					expect((await migrator.migrateDown()).error).toBeUndefined();
					await sql`update settings set docker_seed_images = '[]'`.execute(trx);
					expect((await migrator.migrateToLatest()).error).toBeUndefined();
					expect(await flag()).toBe(false);
					expect((await migrator.migrateDown()).error).toBeUndefined();
					expect((await migrator.migrateDown()).error).toBeUndefined();
					expect((await migrator.migrateDown()).error).toBeUndefined();
					expect((await migrator.migrateDown()).error).toBeUndefined();
					expect((await migrator.migrateDown()).error).toBeUndefined();
					expect((await migrator.migrateDown()).error).toBeUndefined();
					await sql`insert into audit_events (actor, target, action, result, metadata)
						values ('user:x', 'docker', 'docker.seed_images_changed', 'ok', '{}')`.execute(
						trx,
					);
					expect((await migrator.migrateToLatest()).error).toBeUndefined();
					expect(await flag()).toBe(true);
					throw rollback;
				}),
			).rejects.toBe(rollback);
		},
	);
	test.skipIf(!hasTestDb())(
		"0032 keys pulls by day, keeps old rows on their last day, and folds them back",
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
					const user = await trx
						.insertInto("users")
						.values({
							oidc_issuer: "https://idp.test",
							oidc_subject: "pulls",
							display_name: "Pulls",
							role: "student",
						})
						.returning("id")
						.executeTakeFirstOrThrow();
					const ws = await trx
						.insertInto("workspaces")
						.values({ owner_user_id: user.id, label: "pulls", state: "stopped" })
						.returning("id")
						.executeTakeFirstOrThrow();
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0040_signin_counters",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0039_notification_flags",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0038_account_invitations",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0037_second_factor",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0036_start_retries_and_controller_check",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0035_docker_seed_images_set",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0034_keep_running",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0033_ghcr_default_on",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0032_docker_pull_days",
					);
					await sql`insert into docker_image_pulls
						(image, workspace_id, pulls, first_seen, last_seen)
						values ('docker.io/library/redis:7', ${ws.id}, 3,
							'2026-09-01T10:00:00Z', '2026-09-20T23:30:00Z')`.execute(trx);
					expect((await migrator.migrateToLatest()).error).toBeUndefined();
					const rows = await sql<{ day: string }>`
						select to_char(day, 'YYYY-MM-DD') as day from docker_image_pulls`.execute(
						trx,
					);
					expect(rows.rows).toEqual([{ day: "2026-09-20" }]);
					// A second day for the same image and workspace is its own row.
					await trx
						.insertInto("docker_image_pulls")
						.values({
							image: "docker.io/library/redis:7",
							workspace_id: ws.id,
							day: "2026-09-21",
							pulls: 2,
						})
						.execute();
					expect((await migrator.migrateDown()).error).toBeUndefined();
					expect((await migrator.migrateDown()).error).toBeUndefined();
					expect((await migrator.migrateDown()).error).toBeUndefined();
					expect((await migrator.migrateDown()).error).toBeUndefined();
					expect((await migrator.migrateDown()).error).toBeUndefined();
					expect((await migrator.migrateDown()).error).toBeUndefined();
					expect((await migrator.migrateDown()).error).toBeUndefined();
					expect((await migrator.migrateDown()).error).toBeUndefined();
					expect((await migrator.migrateDown()).error).toBeUndefined();
					const folded = await sql<{ pulls: number }>`
						select pulls from docker_image_pulls`.execute(trx);
					expect(folded.rows).toEqual([{ pulls: 5 }]);
					throw rollback;
				}),
			).rejects.toBe(rollback);
		},
	);
	test.skipIf(!hasTestDb())(
		"0033 turns the ghcr.io cache on for the existing row and for new rows",
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
						"0040_signin_counters",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0039_notification_flags",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0038_account_invitations",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0037_second_factor",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0036_start_retries_and_controller_check",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0035_docker_seed_images_set",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0034_keep_running",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0033_ghcr_default_on",
					);
					await sql`insert into settings (id, shutdown_grace_seconds, docker_ghcr_enabled)
						values (1, 600, false)
						on conflict (id) do update set docker_ghcr_enabled = false`.execute(trx);
					expect((await migrator.migrateToLatest()).error).toBeUndefined();
					const row = await trx
						.selectFrom("settings")
						.select("docker_ghcr_enabled")
						.executeTakeFirstOrThrow();
					expect(row.docker_ghcr_enabled).toBe(true);
					const fresh = await sql<{ d: string }>`
						select column_default as d from information_schema.columns
						where table_name = 'settings' and column_name = 'docker_ghcr_enabled'`.execute(
						trx,
					);
					expect(fresh.rows[0]?.d).toBe("true");
					throw rollback;
				}),
			).rejects.toBe(rollback);
		},
	);
});

describe("backups migration", () => {
	let t: TestDb;

	beforeAll(async () => {
		t = await createTestDb();
	});

	afterAll(async () => {
		await t?.close();
	});

	test.skipIf(!hasTestDb())(
		"0026 allows one waiting backup, one status row, replace-home, and rolls back",
		async () => {
			const { Migrator } = await import("kysely/migration");
			const { migrations } = await import("./migrations/index.js");
			const rollback = new Error("rollback");
			const tables = sql<{ n: number }>`
				select count(*)::int as n from information_schema.tables
				where table_name in ('backup_requests', 'backup_status')`;

			await expect(
				t.db.transaction().execute(async (trx) => {
					const status = await trx.selectFrom("backup_status").selectAll().execute();
					expect(status.map((r) => r.id)).toEqual([1]);

					await trx.insertInto("backup_requests").values({ kind: "backup" }).execute();
					await trx
						.insertInto("backup_requests")
						.values({ kind: "delete_set", args: '{"stamp":"20260924T023000Z"}' })
						.execute();
					await expect(
						trx.insertInto("backup_requests").values({ kind: "backup" }).execute(),
					).rejects.toThrow(/backup_requests_one_backup_idx/);
					throw rollback;
				}),
			).rejects.toBe(rollback);

			await expect(
				t.db.transaction().execute(async (trx) => {
					// A finished backup no longer blocks the next one.
					await trx
						.insertInto("backup_requests")
						.values({ kind: "backup", state: "done" })
						.execute();
					await trx.insertInto("backup_requests").values({ kind: "backup" }).execute();
					await expect(
						sql`insert into backup_requests (kind) values ('rm')`.execute(trx),
					).rejects.toThrow();
					throw rollback;
				}),
			).rejects.toBe(rollback);

			await expect(
				t.db.transaction().execute(async (trx) => {
					const owner = await insertTestUser(trx);
					const ws = await trx
						.insertInto("workspaces")
						.values({ label: testLabel(), owner_user_id: owner, state: "running" })
						.returning("id")
						.executeTakeFirstOrThrow();
					await trx
						.updateTable("workspaces")
						.set({
							pending_operation: "replace-home",
							pending_operation_args: '{"restoreRequestId":"x"}',
						})
						.where("id", "=", ws.id)
						.execute();

					const migrator = new Migrator({
						db: trx,
						provider: { getMigrations: async () => migrations },
					});
					// Past 0031 first.
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0040_signin_counters",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0039_notification_flags",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0038_account_invitations",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0037_second_factor",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0036_start_retries_and_controller_check",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0035_docker_seed_images_set",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0034_keep_running",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0033_ghcr_default_on",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0032_docker_pull_days",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0031_docker_cache",
					);
					// Past 0030 and 0029 first.
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0030_egress_blocked_sites",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0029_package_survey",
					);
					expect((await migrator.migrateDown()).error).toBeUndefined();
					expect((await migrator.migrateDown()).error).toBeUndefined();
					const down = await migrator.migrateDown();
					expect(down.results?.[0]?.migrationName).toBe("0026_backups");
					expect((await tables.execute(trx)).rows[0]?.n).toBe(0);
					const after = await sql<{ pending_operation: string | null }>`
						select pending_operation from workspaces where id = ${ws.id}`.execute(trx);
					expect(after.rows[0]?.pending_operation).toBeNull();
					expect((await migrator.migrateToLatest()).error).toBeUndefined();
					expect((await tables.execute(trx)).rows[0]?.n).toBe(2);
					throw rollback;
				}),
			).rejects.toBe(rollback);
		},
	);
	test.skipIf(!hasTestDb())(
		"0025 adds the egress policy with open defaults, checks its values, and rolls back",
		async () => {
			const { Migrator } = await import("kysely/migration");
			const { migrations } = await import("./migrations/index.js");
			const rollback = new Error("rollback");
			const tables = sql<{ n: number }>`
				select count(*)::int as n from information_schema.tables
				where table_name in ('egress_entries', 'egress_blocked_names')`;
			const columns = sql<{ n: number }>`
				select count(*)::int as n from information_schema.columns
				where table_name = 'settings' and column_name like 'egress_%'`;

			await expect(
				t.db.transaction().execute(async (trx) => {
					await trx.deleteFrom("settings").execute();
					await trx
						.insertInto("settings")
						.values({ id: 1, shutdown_grace_seconds: 600 })
						.execute();
					const row = await trx
						.selectFrom("settings")
						.select(["egress_mode", "egress_presets", "egress_ports", "egress_version"])
						.executeTakeFirstOrThrow();
					expect(row).toEqual({
						egress_mode: "open",
						egress_presets: [],
						egress_ports: [22, 80, 443],
						egress_version: 0,
					});
					await trx
						.insertInto("egress_entries")
						.values({ kind: "host", value: "example.edu", label: "" })
						.execute();
					// A value is listed once; a kind or mode outside the set is refused.
					await sql`savepoint s`.execute(trx);
					await expect(
						trx
							.insertInto("egress_entries")
							.values({ kind: "host", value: "example.edu", label: "" })
							.execute(),
					).rejects.toThrow();
					await sql`rollback to savepoint s`.execute(trx);
					await expect(
						sql`insert into egress_entries (kind, value) values ('url', 'x')`.execute(
							trx,
						),
					).rejects.toThrow();
					await sql`rollback to savepoint s`.execute(trx);
					await expect(
						sql`update settings set egress_mode = 'closed'`.execute(trx),
					).rejects.toThrow();
					await sql`rollback to savepoint s`.execute(trx);
					// The blocked-name table has no workspace, user or address column.
					const blockedColumns = await sql<{ column_name: string }>`
						select column_name from information_schema.columns
						where table_name = 'egress_blocked_names' order by column_name`.execute(
						trx,
					);
					expect(blockedColumns.rows.map((r) => r.column_name)).toEqual([
						"count",
						"day",
						"name",
						"source",
					]);

					const migrator = new Migrator({
						db: trx,
						provider: { getMigrations: async () => migrations },
					});
					// Past 0031 first.
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0040_signin_counters",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0039_notification_flags",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0038_account_invitations",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0037_second_factor",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0036_start_retries_and_controller_check",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0035_docker_seed_images_set",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0034_keep_running",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0033_ghcr_default_on",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0032_docker_pull_days",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0031_docker_cache",
					);
					// Past 0030 and 0029 first.
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0030_egress_blocked_sites",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0029_package_survey",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0028_throttle_hold",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0027_workspace_limits",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0026_backups",
					);
					const down = await migrator.migrateDown();
					expect(down.results?.[0]?.migrationName).toBe("0025_egress");
					expect((await tables.execute(trx)).rows[0]?.n).toBe(0);
					expect((await columns.execute(trx)).rows[0]?.n).toBe(0);
					expect((await migrator.migrateToLatest()).error).toBeUndefined();
					expect((await tables.execute(trx)).rows[0]?.n).toBe(2);
					expect((await columns.execute(trx)).rows[0]?.n).toBe(7);
					throw rollback;
				}),
			).rejects.toBe(rollback);
		},
	);
});

describe("api request samples migration", () => {
	let t: TestDb;

	beforeAll(async () => {
		t = await createTestDb();
	});

	afterAll(async () => {
		await t?.close();
	});

	test.skipIf(!hasTestDb())(
		"0022 creates api_request_samples and rolls back",
		async () => {
			const { Migrator } = await import("kysely/migration");
			const { migrations } = await import("./migrations/index.js");
			const rollback = new Error("rollback");
			const exists = sql<{ n: number }>`
				select count(*)::int as n from information_schema.tables
				where table_name = 'api_request_samples'`;

			await expect(
				t.db.transaction().execute(async (trx) => {
					const minute = new Date("2026-09-26T10:00:00Z");
					const row = {
						minute,
						requests: 1,
						client_errors: 0,
						server_errors: 0,
						websocket_upgrades: 0,
						latency_buckets: [1, 0],
					};
					await trx.insertInto("api_request_samples").values(row).execute();
					const migrator = new Migrator({
						db: trx,
						provider: { getMigrations: async () => migrations },
					});
					// Past 0031 first.
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0040_signin_counters",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0039_notification_flags",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0038_account_invitations",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0037_second_factor",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0036_start_retries_and_controller_check",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0035_docker_seed_images_set",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0034_keep_running",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0033_ghcr_default_on",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0032_docker_pull_days",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0031_docker_cache",
					);
					// Past 0030 and 0029 first.
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0030_egress_blocked_sites",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0029_package_survey",
					);
					// Past 0028, 0027, 0026, 0025, 0024 and 0023 first.
					expect((await migrator.migrateDown()).error).toBeUndefined();
					expect((await migrator.migrateDown()).error).toBeUndefined();
					expect((await migrator.migrateDown()).error).toBeUndefined();
					expect((await migrator.migrateDown()).error).toBeUndefined();
					expect((await migrator.migrateDown()).error).toBeUndefined();
					expect((await migrator.migrateDown()).error).toBeUndefined();
					const down = await migrator.migrateDown();
					expect(down.error).toBeUndefined();
					expect(down.results?.[0]?.migrationName).toBe("0022_api_request_samples");
					expect((await exists.execute(trx)).rows[0]?.n).toBe(0);
					const up = await migrator.migrateToLatest();
					expect(up.error).toBeUndefined();
					expect((await exists.execute(trx)).rows[0]?.n).toBe(1);
					throw rollback;
				}),
			).rejects.toBe(rollback);
		},
	);
});

// ── Pool guard rails (ADR 0034) ──

describe("pool options", () => {
	test("bound the wait for a connection, a statement and an idle transaction", () => {
		expect(poolOptions("postgres://x/y", 3)).toEqual({
			connectionString: "postgres://x/y",
			max: 3,
			connectionTimeoutMillis: 5000,
			statement_timeout: 30_000,
			idle_in_transaction_session_timeout: 60_000,
		});
	});

	test("only the pool's own timeout counts as a pool timeout", () => {
		expect(isPoolTimeout(new Error("timeout exceeded when trying to connect"))).toBe(
			true,
		);
		expect(isPoolTimeout(new Error("connection refused"))).toBe(false);
		expect(isPoolTimeout("timeout exceeded when trying to connect")).toBe(false);
	});

	test("an idle connection dying is reported, not thrown", async () => {
		const heard: Error[] = [];
		const pool = createPool("postgres://x/y", 1, (error) => heard.push(error));
		// With no listener, EventEmitter throws an "error" event, ending the process.
		expect(() => pool.emit("error", new Error("terminated"))).not.toThrow();
		expect(heard.map((e) => e.message)).toEqual(["terminated"]);
		await pool.end();
	});

	test.skipIf(!hasTestDb())(
		"a checked-out connection dying does not throw",
		async () => {
			// Kysely holds a client outside pg-pool's idle listener for every
			// query; PostgreSQL dying mid-query emits "error" on that client.
			const pool = createPool(process.env.TEST_DATABASE_URL as string, 1, () => {});
			const client = await pool.connect();
			try {
				expect(() => client.emit("error", new Error("terminated"))).not.toThrow();
			} finally {
				client.release(true);
				await pool.end();
			}
		},
	);

	test("an unreachable database counts as unavailable; query errors do not", () => {
		const coded = (message: string, code: string) =>
			Object.assign(new Error(message), { code });
		expect(
			isDatabaseUnavailable(new Error("timeout exceeded when trying to connect")),
		).toBe(true);
		expect(isDatabaseUnavailable(coded("connect ECONNREFUSED", "ECONNREFUSED"))).toBe(
			true,
		);
		expect(
			isDatabaseUnavailable(coded("the database system is starting up", "57P03")),
		).toBe(true);
		expect(
			isDatabaseUnavailable(
				new Error("Connection terminated due to connection timeout"),
			),
		).toBe(true);
		expect(isDatabaseUnavailable(coded("syntax error", "42601"))).toBe(false);
		expect(isDatabaseUnavailable(new Error("boom"))).toBe(false);
		expect(isDatabaseUnavailable("ECONNREFUSED")).toBe(false);
	});

	test.skipIf(!hasTestDb())(
		"a full pool fails the next query in about five seconds",
		async () => {
			const db = createDb(process.env.TEST_DATABASE_URL as string, 1);
			try {
				let release: () => void = () => {};
				const held = db
					.transaction()
					.execute(() => new Promise<void>((resolve) => (release = resolve)));
				const started = Date.now();
				const error = await sql`select 1`.execute(db).catch((e: unknown) => e);
				const waited = Date.now() - started;
				release();
				await held;
				expect(isPoolTimeout(error)).toBe(true);
				expect(waited).toBeGreaterThanOrEqual(4500);
				expect(waited).toBeLessThan(8000);
			} finally {
				await db.destroy();
			}
		},
		15_000,
	);
});

describe("throttle hold migration", () => {
	let t: TestDb;

	beforeAll(async () => {
		t = await createTestDb();
	});

	afterAll(async () => {
		await t?.close();
	});

	test.skipIf(!hasTestDb())(
		"0028 adds the hold settings with their defaults and bounds, the recent list, and rolls back",
		async () => {
			const { Migrator } = await import("kysely/migration");
			const { migrations } = await import("./migrations/index.js");
			const rollback = new Error("rollback");
			const columns = sql<{ n: number }>`
				select count(*)::int as n from information_schema.columns
				where (table_name = 'settings'
					and column_name in ('cpu_throttle_hold_after', 'cpu_throttle_hold_hours'))
				or (table_name = 'workspaces' and column_name = 'cpu_throttle_recent')`;

			await expect(
				t.db.transaction().execute(async (trx) => {
					await trx
						.insertInto("settings")
						.values({ id: 1, shutdown_grace_seconds: 600 })
						.execute();
					const row = await trx
						.selectFrom("settings")
						.select(["cpu_throttle_hold_after", "cpu_throttle_hold_hours"])
						.executeTakeFirstOrThrow();
					expect(row).toEqual({
						cpu_throttle_hold_after: 3,
						cpu_throttle_hold_hours: 24,
					});
					for (const bad of [
						sql`update settings set cpu_throttle_hold_after = 11`,
						sql`update settings set cpu_throttle_hold_after = -1`,
						sql`update settings set cpu_throttle_hold_hours = 0`,
						sql`update settings set cpu_throttle_hold_hours = 169`,
					]) {
						await expect(
							sql`savepoint bound`.execute(trx).then(() => bad.execute(trx)),
						).rejects.toThrow(/cpu_throttle_hold/);
						await sql`rollback to savepoint bound`.execute(trx);
					}
					const owner = await insertTestUser(trx);
					const ws = await trx
						.insertInto("workspaces")
						.values({ label: testLabel(), owner_user_id: owner, state: "running" })
						.returning("cpu_throttle_recent")
						.executeTakeFirstOrThrow();
					expect(ws.cpu_throttle_recent).toEqual([]);

					const migrator = new Migrator({
						db: trx,
						provider: { getMigrations: async () => migrations },
					});
					// Past 0031 first.
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0040_signin_counters",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0039_notification_flags",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0038_account_invitations",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0037_second_factor",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0036_start_retries_and_controller_check",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0035_docker_seed_images_set",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0034_keep_running",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0033_ghcr_default_on",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0032_docker_pull_days",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0031_docker_cache",
					);
					// Past 0030 and 0029 first.
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0030_egress_blocked_sites",
					);
					expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
						"0029_package_survey",
					);
					const down = await migrator.migrateDown();
					expect(down.results?.[0]?.migrationName).toBe("0028_throttle_hold");
					expect((await columns.execute(trx)).rows[0]?.n).toBe(0);
					expect((await migrator.migrateToLatest()).error).toBeUndefined();
					expect((await columns.execute(trx)).rows[0]?.n).toBe(3);
					throw rollback;
				}),
			).rejects.toBe(rollback);
		},
	);
});
