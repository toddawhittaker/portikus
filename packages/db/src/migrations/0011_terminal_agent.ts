import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
	// Which launcher started this terminal, and the review baseline taken
	// before it ran (SPEC.md §10.8, §10.9). An ordinary shell leaves all
	// three null. The object ids are Git objects, not a second snapshot.
	await db.schema.alterTable("terminals").addColumn("agent", "text").execute();
	await db.schema
		.alterTable("terminals")
		.addColumn("baseline_object_id", "text")
		.execute();
	await db.schema.alterTable("terminals").addColumn("baseline_head", "text").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.alterTable("terminals").dropColumn("baseline_head").execute();
	await db.schema.alterTable("terminals").dropColumn("baseline_object_id").execute();
	await db.schema.alterTable("terminals").dropColumn("agent").execute();
}
