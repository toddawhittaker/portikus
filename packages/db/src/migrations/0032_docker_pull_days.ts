import { type Kysely, sql } from "kysely";

/**
 * Registry pulls counted per UTC day (SPEC.md section 16.6), so the usage
 * report sums only the pulls inside its window and the daily name cap
 * counts only today's names. Existing rows keep their last day.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`alter table docker_image_pulls add column day date`.execute(db);
	await sql`update docker_image_pulls
		set day = (last_seen at time zone 'UTC')::date`.execute(db);
	await sql`alter table docker_image_pulls
		alter column day set not null,
		drop constraint docker_image_pulls_pkey,
		add primary key (image, workspace_id, day)`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	// Fold the days back into one row per image and workspace.
	await sql`create temporary table docker_image_pulls_fold as
		select image, workspace_id, sum(pulls)::int as pulls,
			min(first_seen) as first_seen, max(last_seen) as last_seen
		from docker_image_pulls group by image, workspace_id`.execute(db);
	await sql`delete from docker_image_pulls`.execute(db);
	await sql`alter table docker_image_pulls
		drop constraint docker_image_pulls_pkey,
		drop column day,
		add primary key (image, workspace_id)`.execute(db);
	await sql`insert into docker_image_pulls (image, workspace_id, pulls, first_seen, last_seen)
		select image, workspace_id, pulls, first_seen, last_seen
		from docker_image_pulls_fold`.execute(db);
	await sql`drop table docker_image_pulls_fold`.execute(db);
}
