import { type Kysely, sql } from "kysely";

/**
 * Whether an administrator has ever set the seed list. Until
 * then the API may fill an empty list with the images matching the default
 * workspace image; after, it never edits the list on its own.
 * An existing list counts as set when it holds images or was ever saved.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`alter table settings
		add column docker_seed_images_set boolean not null default false`.execute(db);
	await sql`update settings set docker_seed_images_set = true
		where docker_seed_images <> '[]'::jsonb
		or exists (select 1 from audit_events where action = 'docker.seed_images_changed')`.execute(
		db,
	);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await sql`alter table settings drop column docker_seed_images_set`.execute(db);
}
