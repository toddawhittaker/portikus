import { type Kysely, sql } from "kysely";

/**
 * How each session started, and the exact archive a link wrote (Epic 13.1
 * review fixes S1, S2 and S5; ADR 0026). An existing session of a course
 * account came from a launch, and one of any other account from SSO. A
 * session of either side of a link cannot be told apart, so it is ended.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`alter table sessions add column method text not null default 'oidc'`.execute(
		db,
	);
	await sql`alter table sessions add constraint sessions_method_check check (method in ('oidc','lti','link'))`.execute(
		db,
	);
	// The course identity behind a linked launch; only a launch session has one.
	await sql`alter table sessions add column course_user_id uuid references users(id) on delete cascade`.execute(
		db,
	);
	await sql`alter table sessions add constraint sessions_course_user_check check (course_user_id is null or method = 'lti')`.execute(
		db,
	);
	await sql`delete from sessions s where exists (
		select 1 from account_links l
		where l.user_id = s.user_id or l.course_user_id = s.user_id)`.execute(db);
	await sql`update sessions s set method = 'lti'
		from users u where u.id = s.user_id and u.oidc_issuer like 'lti:%'`.execute(db);

	await sql`alter table account_links add column archived_at timestamptz`.execute(db);
	// Only an archive written with the link; a later one is not the link's to undo.
	await sql`update account_links l set archived_at = w.archived_at
		from workspaces w
		where l.archived_workspace and w.owner_user_id = l.course_user_id
		and abs(extract(epoch from w.archived_at - l.created_at)) <= 5`.execute(db);
	await sql`alter table account_links drop column archived_workspace`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await sql`alter table account_links add column archived_workspace boolean not null default false`.execute(
		db,
	);
	await sql`update account_links set archived_workspace = archived_at is not null`.execute(
		db,
	);
	await sql`alter table account_links alter column archived_workspace drop default`.execute(
		db,
	);
	await sql`alter table account_links drop column archived_at`.execute(db);
	await sql`alter table sessions drop column course_user_id`.execute(db);
	await sql`alter table sessions drop column method`.execute(db);
}
