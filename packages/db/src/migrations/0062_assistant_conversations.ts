import { type Kysely, sql } from "kysely";

/**
 * Assistant conversations (SPEC.md sections 20.4 and 24.1). A conversation
 * belongs to one person and every query filters on that owner. It is stored
 * as our own event log, never the model library's message format. An
 * approval is a row claimed once with `update ... where status = 'pending'`,
 * so it survives a restart and two tabs cannot run it twice. Conversations
 * are deleted 30 days after `last_active_at`. The worker has no grants.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`create table assistant_conversations (
		id uuid primary key default gen_random_uuid(),
		user_id uuid not null references users (id) on delete cascade,
		course_id uuid references lti_contexts (id) on delete cascade,
		context jsonb,
		read_only boolean not null default false,
		title text,
		tokens_used bigint not null default 0 check (tokens_used >= 0),
		created_at timestamptz not null default now(),
		last_active_at timestamptz not null default now()
	)`.execute(db);
	await sql`create index assistant_conversations_owner_idx
		on assistant_conversations (user_id, last_active_at desc)`.execute(db);
	await sql`create index assistant_conversations_active_idx
		on assistant_conversations (last_active_at)`.execute(db);
	await sql`create table assistant_events (
		conversation_id uuid not null
			references assistant_conversations (id) on delete cascade,
		seq integer not null,
		event jsonb not null,
		created_at timestamptz not null default now(),
		primary key (conversation_id, seq)
	)`.execute(db);
	await sql`create table assistant_approvals (
		id uuid primary key default gen_random_uuid(),
		conversation_id uuid not null
			references assistant_conversations (id) on delete cascade,
		tool_call_id text not null,
		operation text not null,
		input jsonb not null,
		risk text not null check (risk in ('change', 'destructive')),
		confirm_text text,
		status text not null default 'pending'
			check (status in ('pending', 'approved', 'denied', 'expired')),
		created_at timestamptz not null default now(),
		decided_at timestamptz,
		unique (conversation_id, tool_call_id)
	)`.execute(db);
	await sql`create index assistant_approvals_pending_idx
		on assistant_approvals (conversation_id) where status = 'pending'`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await sql`drop table assistant_approvals`.execute(db);
	await sql`drop table assistant_events`.execute(db);
	await sql`drop table assistant_conversations`.execute(db);
}
