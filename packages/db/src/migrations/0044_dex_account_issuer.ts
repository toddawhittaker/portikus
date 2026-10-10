import { type Kysely, sql } from "kysely";

/**
 * Key every Dex account by the logical issuer instead of Dex's URL, so an
 * address move keeps each account, its workspace and its links (SPEC.md
 * section 5.1; ADR 0031). Dex subjects carry no host, so only the issuer
 * changes. A migration has no OIDC_ISSUER_URL, so a Dex row is any issuer
 * of the form `http(s)://<host>/dex`. The value is written out here because
 * a migration must never change after it ships; the code reads it from
 * DEX_ACCOUNT_ISSUER in @portikus/auth.
 *
 * A site already moved has one row per address for the same subject. One
 * takes the logical issuer and the others stay as they are: the one signed
 * into last, then one that owns a workspace, then the newest, then the
 * lowest id. A row already under the logical issuer wins, so a second run
 * changes nothing.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`
		update users set oidc_issuer = 'urn:portikus:dex'
		where id in (
			select distinct on (u.oidc_subject) u.id from users u
			where u.oidc_issuer like 'http%/dex'
			order by u.oidc_subject,
				u.last_login_at desc nulls last,
				exists (select 1 from workspaces w where w.owner_user_id = u.id) desc,
				u.created_at desc,
				u.id
		)
		and not exists (
			select 1 from users kept
			where kept.oidc_issuer = 'urn:portikus:dex'
				and kept.oidc_subject = users.oidc_subject
		)`.execute(db);
}

/** No-op: the old URL is not stored anywhere, and the logical issuer works at any address. */
export async function down(_db: Kysely<unknown>): Promise<void> {}
