import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import {
	basePrefix,
	createTestDb,
	hasTestDb,
	hostId,
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
	});

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
				]);
				throw rollback;
			}),
		).rejects.toBe(rollback);
	});

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

		const grant = await t.db
			.insertInto("preview_grants")
			.values({
				user_id: userId,
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

			await expect(
				t.db
					.insertInto("preview_grants")
					.values({
						user_id: userId,
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
					partitioned: true,
				})
				.execute();

			await t.db.deleteFrom("sessions").where("id", "=", "session-hash").execute();

			const left = await t.db.selectFrom("preview_sessions").selectAll().execute();
			expect(left).toHaveLength(0);
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
