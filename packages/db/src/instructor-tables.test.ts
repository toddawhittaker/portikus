import { type Kysely, sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import type { Database } from "./schema.js";
import {
	createTestDb,
	hasTestDb,
	insertTestLtiMembership,
	insertTestUser,
	type TestDb,
} from "./testing.js";

// The tables for shares, roster sync, Deep Linking starters and agent usage
// (ADR 0057, ADR 0058).

async function insertProject(db: Kysely<Database>): Promise<string> {
	const owner = await insertTestUser(db);
	const workspace = await db
		.insertInto("workspaces")
		.values({
			label: `ws-${owner.slice(0, 8)}`,
			owner_user_id: owner,
			state: "running",
		})
		.returning("id")
		.executeTakeFirstOrThrow();
	const project = await db
		.insertInto("projects")
		.values({
			workspace_id: workspace.id,
			slug: "demo",
			name: "Demo",
			path: "/home/student/projects/demo",
			source: "new",
		})
		.returning("id")
		.executeTakeFirstOrThrow();
	return project.id;
}

const inADay = () => new Date(Date.now() + 24 * 3600_000).toISOString();

describe("instructor feature tables", () => {
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

	test.skipIf(!hasTestDb())("0041 to 0043 roll back and reapply", async () => {
		const { Migrator } = await import("kysely/migration");
		const { migrations } = await import("./migrations/index.js");
		const rollback = new Error("rollback");
		const tables = sql<{ n: number }>`
			select count(*)::int as n from information_schema.tables
			where table_name in ('lti_roster_members', 'lti_deep_link_requests',
				'lti_starter_launches', 'project_shares', 'project_share_views',
				'agent_usage_days')`;
		const contextColumns = sql<{ n: number }>`
			select count(*)::int as n from information_schema.columns
			where table_name = 'lti_contexts'
			and column_name in ('platform_client_id', 'nrps_url', 'roster_synced_at',
				'roster_sync_result')`;

		await expect(
			t.db.transaction().execute(async (trx) => {
				expect((await tables.execute(trx)).rows[0]?.n).toBe(6);
				expect((await contextColumns.execute(trx)).rows[0]?.n).toBe(4);
				const migrator = new Migrator({
					db: trx,
					provider: { getMigrations: async () => migrations },
				});
				for (const name of [
					"0043_agent_usage_days",
					"0042_project_shares",
					"0041_lti_roster_and_deep_linking",
				]) {
					const down = await migrator.migrateDown();
					expect(down.error).toBeUndefined();
					expect(down.results?.[0]?.migrationName).toBe(name);
				}
				expect((await tables.execute(trx)).rows[0]?.n).toBe(0);
				expect((await contextColumns.execute(trx)).rows[0]?.n).toBe(0);

				const up = await migrator.migrateToLatest();
				expect(up.error).toBeUndefined();
				expect(up.results?.map((r) => r.migrationName)).toEqual([
					"0041_lti_roster_and_deep_linking",
					"0042_project_shares",
					"0043_agent_usage_days",
				]);
				expect((await tables.execute(trx)).rows[0]?.n).toBe(6);
				expect((await contextColumns.execute(trx)).rows[0]?.n).toBe(4);
				throw rollback;
			}),
		).rejects.toBe(rollback);
	});

	test.skipIf(!hasTestDb())("a project has at most one open share", async () => {
		const projectId = await insertProject(t.db);
		const first = await t.db
			.insertInto("project_shares")
			.values({ project_id: projectId, ends_at: inADay() })
			.returning("id")
			.executeTakeFirstOrThrow();
		await expect(
			t.db
				.insertInto("project_shares")
				.values({ project_id: projectId, ends_at: inADay() })
				.execute(),
		).rejects.toThrow(/project_shares_one_open/);

		// Once closed, a new share may start, and closed ones pile up freely.
		await t.db
			.updateTable("project_shares")
			.set({ ended_at: new Date().toISOString() })
			.where("id", "=", first.id)
			.execute();
		await t.db
			.insertInto("project_shares")
			.values({ project_id: projectId, ends_at: inADay() })
			.execute();
		const rows = await t.db
			.selectFrom("project_shares")
			.select("ended_at")
			.where("project_id", "=", projectId)
			.execute();
		expect(rows.filter((row) => row.ended_at === null)).toHaveLength(1);
		expect(rows).toHaveLength(2);
	});

	test.skipIf(!hasTestDb())("a share must end after it starts", async () => {
		const projectId = await insertProject(t.db);
		await expect(
			t.db
				.insertInto("project_shares")
				.values({ project_id: projectId, ends_at: "2000-01-01T00:00:00Z" })
				.execute(),
		).rejects.toThrow(/project_shares_ends_after_start/);
	});

	test.skipIf(!hasTestDb())(
		"a share and its views go with the project, and a view with its viewer",
		async () => {
			const projectId = await insertProject(t.db);
			const share = await t.db
				.insertInto("project_shares")
				.values({ project_id: projectId, ends_at: inADay() })
				.returning("id")
				.executeTakeFirstOrThrow();
			const viewers = [await insertTestUser(t.db), await insertTestUser(t.db)];
			for (const viewer of viewers) {
				await t.db
					.insertInto("project_share_views")
					.values({ share_id: share.id, viewer_user_id: viewer })
					.execute();
			}
			// One row per share and viewer.
			await expect(
				t.db
					.insertInto("project_share_views")
					.values({ share_id: share.id, viewer_user_id: viewers[0] as string })
					.execute(),
			).rejects.toThrow(/project_share_views_pkey/);

			await t.db
				.deleteFrom("users")
				.where("id", "=", viewers[0] as string)
				.execute();
			expect(
				await t.db.selectFrom("project_share_views").select("viewer_user_id").execute(),
			).toEqual([{ viewer_user_id: viewers[1] }]);

			await t.db.deleteFrom("projects").where("id", "=", projectId).execute();
			expect(await t.db.selectFrom("project_shares").select("id").execute()).toEqual(
				[],
			);
			expect(
				await t.db.selectFrom("project_share_views").select("share_id").execute(),
			).toEqual([]);
		},
	);

	test.skipIf(!hasTestDb())(
		"a starter launch names exactly one of a template and a repository",
		async () => {
			const userId = await insertTestUser(t.db);
			const base = {
				user_id: userId,
				project_name: "Lab 1",
				expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
			};
			for (const bad of [
				{ template: null, repository_url: null },
				{ template: "python", repository_url: "https://example.test/lab.git" },
			]) {
				await expect(
					t.db
						.insertInto("lti_starter_launches")
						.values({ ...base, ...bad })
						.execute(),
				).rejects.toThrow(/lti_starter_launches_one_source/);
			}
			await t.db
				.insertInto("lti_starter_launches")
				.values({ ...base, template: "python", repository_url: null })
				.execute();
			await t.db
				.insertInto("lti_starter_launches")
				.values({
					...base,
					template: null,
					repository_url: "https://example.test/x.git",
				})
				.execute();

			await t.db.deleteFrom("users").where("id", "=", userId).execute();
			expect(
				await t.db.selectFrom("lti_starter_launches").select("id").execute(),
			).toEqual([]);
		},
	);

	test.skipIf(!hasTestDb())(
		"roster members are keyed by course and subject and go with the course",
		async () => {
			const instructor = await insertTestUser(t.db);
			const courseId = await insertTestLtiMembership(t.db, instructor, {
				role: "instructor",
			});
			const row = {
				context_id: courseId,
				subject: "lms-subject-1",
				display_name: "Nora Newcomer",
				role: "student",
			};
			await t.db.insertInto("lti_roster_members").values(row).execute();
			await expect(
				t.db.insertInto("lti_roster_members").values(row).execute(),
			).rejects.toThrow(/lti_roster_members_pkey/);
			await expect(
				t.db
					.insertInto("lti_roster_members")
					.values({ ...row, subject: "lms-subject-2", role: "administrator" })
					.execute(),
			).rejects.toThrow(/lti_roster_members_role_check/);

			// A course starts with no roster state.
			const course = await t.db
				.selectFrom("lti_contexts")
				.select([
					"platform_client_id",
					"nrps_url",
					"roster_synced_at",
					"roster_sync_result",
				])
				.where("id", "=", courseId)
				.executeTakeFirstOrThrow();
			expect(course).toEqual({
				platform_client_id: null,
				nrps_url: null,
				roster_synced_at: null,
				roster_sync_result: null,
			});

			await t.db.deleteFrom("lti_contexts").where("id", "=", courseId).execute();
			expect(
				await t.db.selectFrom("lti_roster_members").select("subject").execute(),
			).toEqual([]);
		},
	);

	test.skipIf(!hasTestDb())(
		"a Deep Linking request keeps its handle hash once",
		async () => {
			const row = {
				state_hash: "a".repeat(64),
				platform_issuer: "https://lms.test.invalid",
				client_id: "client-1",
				deployment_id: "deployment-1",
				return_url: "https://lms.test.invalid/deep-link/return",
				data: null,
				expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
			};
			await t.db.insertInto("lti_deep_link_requests").values(row).execute();
			await expect(
				t.db.insertInto("lti_deep_link_requests").values(row).execute(),
			).rejects.toThrow(/lti_deep_link_requests_pkey/);
		},
	);

	test.skipIf(!hasTestDb())(
		"agent usage upserts by boot, day, agent and model and checks its values",
		async () => {
			const userId = await insertTestUser(t.db);
			const row = {
				user_id: userId,
				boot_id: "6f1c4c0e-8f1a-4c55-9a51-6c1b2a0f0001",
				day: "2026-10-10",
				agent: "claude" as const,
				model: "claude-opus-5-5",
				sessions: 1,
				input_tokens: 100,
				output_tokens: 50,
			};
			const upsert = (values: typeof row) =>
				t.db
					.insertInto("agent_usage_days")
					.values(values)
					.onConflict((oc) =>
						oc.columns(["user_id", "boot_id", "day", "agent", "model"]).doUpdateSet({
							sessions: values.sessions,
							input_tokens: values.input_tokens,
							output_tokens: values.output_tokens,
						}),
					)
					.execute();
			await upsert(row);
			// A repeated report of the same boot overwrites, never adds.
			await upsert({ ...row, sessions: 2, input_tokens: 300 });
			const rows = await t.db
				.selectFrom("agent_usage_days")
				.select([
					"sessions",
					"input_tokens",
					"output_tokens",
					"cost_usd",
					"lines_added",
				])
				.execute();
			expect(rows).toEqual([
				{
					sessions: "2",
					input_tokens: "300",
					output_tokens: "50",
					cost_usd: null,
					lines_added: "0",
				},
			]);

			for (const [bad, constraint] of [
				[{ agent: "gpt" }, "agent_usage_days_agent_check"],
				[{ model: "m".repeat(101) }, "agent_usage_days_model_check"],
				[{ model: "" }, "agent_usage_days_model_check"],
				[{ input_tokens: -1 }, "agent_usage_days_counts_check"],
			] as const) {
				await expect(
					t.db
						.insertInto("agent_usage_days")
						.values({
							...row,
							boot_id: "6f1c4c0e-8f1a-4c55-9a51-6c1b2a0f0002",
							...(bad as object),
						})
						.execute(),
				).rejects.toThrow(new RegExp(constraint));
			}

			await t.db.deleteFrom("users").where("id", "=", userId).execute();
			expect(await t.db.selectFrom("agent_usage_days").select("day").execute()).toEqual(
				[],
			);
		},
	);
});
