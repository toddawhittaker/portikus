import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
	// Archive parks a workspace without touching its data (SPEC.md §20.1).
	await db.schema
		.alterTable("workspaces")
		.addColumn("archived_at", "timestamptz")
		.execute();
	// The sizes the worker last applied; quota_config is the size wanted.
	await db.schema
		.alterTable("workspaces")
		.addColumn("quota_applied", "jsonb")
		.execute();
	// Only the two grown volumes; quota_config may also hold Epic 10's recoveryGiB.
	await sql`update workspaces set quota_applied = jsonb_build_object('homeGiB', quota_config->'homeGiB', 'dockerGiB', quota_config->'dockerGiB') where quota_config is not null`.execute(
		db,
	);

	// One host snapshot a minute from the worker, kept 7 days (SPEC.md §25.6).
	await db.schema
		.createTable("health_samples")
		.addColumn("id", "bigserial", (col) => col.primaryKey())
		.addColumn("observed_at", "timestamptz", (col) =>
			col.notNull().defaultTo(sql`now()`),
		)
		.addColumn("sample", "jsonb", (col) => col.notNull())
		.execute();
	await db.schema
		.createIndex("health_samples_observed_at_idx")
		.on("health_samples")
		.column("observed_at")
		.execute();

	// The audit tab filters by target and actor and pages by id; health counts by action.
	await sql`create index audit_events_target_id_idx on audit_events (target, id desc)`.execute(
		db,
	);
	await sql`create index audit_events_actor_id_idx on audit_events (actor, id desc)`.execute(
		db,
	);
	await db.schema
		.createIndex("audit_events_action_at_idx")
		.on("audit_events")
		.columns(["action", "at"])
		.execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.dropIndex("audit_events_action_at_idx").execute();
	await db.schema.dropIndex("audit_events_actor_id_idx").execute();
	await db.schema.dropIndex("audit_events_target_id_idx").execute();
	await db.schema.dropTable("health_samples").execute();
	await db.schema.alterTable("workspaces").dropColumn("quota_applied").execute();
	await db.schema.alterTable("workspaces").dropColumn("archived_at").execute();
}
