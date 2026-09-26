import * as crypto from "node:crypto";
import { hashSessionToken, loadSessionById } from "@portikus/auth";
import type { AuthUser, PreviewPresentation } from "@portikus/contracts";
import type { Database } from "@portikus/db";
import { type Kysely, sql } from "kysely";

/**
 * Bootstrap tickets and preview sessions (BROWSER-HANDLING.md §9.1, §9.2,
 * §17). Only the hash of a ticket or a preview token is ever stored, the same
 * way the main session does it.
 */
function newToken(): string {
	return crypto.randomBytes(32).toString("base64url");
}

export interface GrantInput {
	userId: string;
	sessionId: string;
	workspaceId: string;
	port: number;
	previewHost: string;
	presentation: PreviewPresentation;
	ttlSeconds: number;
}

/** Create a single-use bootstrap ticket and return the clear-text ticket. */
export async function createGrant(
	db: Kysely<Database>,
	input: GrantInput,
): Promise<{ ticket: string; expiresAt: Date }> {
	// No sweeper process: every new grant clears the ones nobody can use.
	await db
		.deleteFrom("preview_grants")
		.where("expires_at", "<", sql<Date>`now()`)
		.execute();
	await sweepDeadPreviewSessions(db);

	const ticket = newToken();
	const expiresAt = new Date(Date.now() + input.ttlSeconds * 1000);
	await db
		.insertInto("preview_grants")
		.values({
			user_id: input.userId,
			session_id: input.sessionId,
			workspace_id: input.workspaceId,
			port: input.port,
			preview_host: input.previewHost,
			presentation: input.presentation,
			ticket_hash: hashSessionToken(ticket),
			expires_at: expiresAt.toISOString(),
		})
		.execute();
	return { ticket, expiresAt };
}

/**
 * Drop preview sessions nobody can use again: revoked more than a day ago, or
 * living with a main session that has gone or run out. Kept a day so that a
 * question about a preview that was just closed can still be answered. Runs
 * with the grant sweep, because the same route is the only writer here.
 */
export async function sweepDeadPreviewSessions(db: Kysely<Database>): Promise<void> {
	await db
		.deleteFrom("preview_sessions")
		.where((eb) =>
			eb.or([
				eb("revoked_at", "<", sql<Date>`now() - interval '1 day'`),
				eb.not(
					eb.exists(
						eb
							.selectFrom("sessions")
							.select("sessions.id")
							.whereRef("sessions.id", "=", "preview_sessions.session_id")
							.where("sessions.expires_at", ">", sql<Date>`now()`),
					),
				),
			]),
		)
		.execute();
}

export interface ConsumedGrant {
	user_id: string;
	session_id: string;
	workspace_id: string;
	port: number;
	preview_host: string;
	presentation: string;
}

/**
 * Consume a ticket for exactly this host. The update is the check: a replay,
 * an expired ticket, or a ticket presented on another host matches no row,
 * so two racing requests cannot both win.
 */
export async function consumeGrant(
	db: Kysely<Database>,
	ticket: string,
	previewHost: string,
): Promise<ConsumedGrant | null> {
	const row = await db
		.updateTable("preview_grants")
		.set({ consumed_at: new Date().toISOString() })
		.where("ticket_hash", "=", hashSessionToken(ticket))
		.where("consumed_at", "is", null)
		.where("expires_at", ">", sql<Date>`now()`)
		.where("preview_host", "=", previewHost)
		.returning([
			"user_id",
			"session_id",
			"workspace_id",
			"port",
			"preview_host",
			"presentation",
		])
		.executeTakeFirst();
	return row ?? null;
}

export interface PreviewSessionInput {
	userId: string;
	sessionId: string;
	workspaceId: string;
	port: number;
	previewHost: string;
}

/**
 * How many live preview sessions one student may hold at once. A preview
 * session already dies with the main Portikus session, but nothing bounded
 * how many one main session could pile up, so a page opening previews in a
 * loop could grow the table without limit. Fifty is far above real use: a
 * student opens a handful of ports.
 */
export const MAX_PREVIEW_SESSIONS_PER_USER = 50;

/** Start a preview session and return the clear-text cookie value. */
export async function createPreviewSession(
	db: Kysely<Database>,
	input: PreviewSessionInput,
): Promise<string> {
	const token = newToken();
	await db
		.insertInto("preview_sessions")
		.values({
			token_hash: hashSessionToken(token),
			user_id: input.userId,
			session_id: input.sessionId,
			workspace_id: input.workspaceId,
			port: input.port,
			preview_host: input.previewHost,
		})
		.execute();
	await revokeOldestOverCap(db, input.userId);
	return token;
}

/** Revoke this user's live preview sessions past the newest fifty. */
async function revokeOldestOverCap(
	db: Kysely<Database>,
	userId: string,
): Promise<void> {
	await db
		.updateTable("preview_sessions")
		.set({ revoked_at: new Date().toISOString() })
		.where("id", "in", (eb) =>
			eb
				.selectFrom("preview_sessions")
				.select("id")
				.where("user_id", "=", userId)
				.where("revoked_at", "is", null)
				.orderBy("created_at", "desc")
				.orderBy("id", "desc")
				.offset(MAX_PREVIEW_SESSIONS_PER_USER),
		)
		.execute();
}

export interface PreviewSessionRow {
	id: string;
	user_id: string;
	session_id: string;
	workspace_id: string;
	port: number;
	preview_host: string;
}

/** The live preview session behind a cookie, or null when it cannot be used. */
export async function loadPreviewSession(
	db: Kysely<Database>,
	token: string,
): Promise<PreviewSessionRow | null> {
	const row = await db
		.selectFrom("preview_sessions")
		.select(["id", "user_id", "session_id", "workspace_id", "port", "preview_host"])
		.where("token_hash", "=", hashSessionToken(token))
		.where("revoked_at", "is", null)
		.executeTakeFirst();
	return row ?? null;
}

/**
 * Whether a cookie belongs to a revoked preview session for this host whose
 * workspace is no longer running. Stopping revokes the sessions, and the
 * student should still be told the workspace stopped (BROWSER-HANDLING.md §9.2).
 */
export async function revokedForStoppedWorkspace(
	db: Kysely<Database>,
	token: string,
	host: string,
): Promise<boolean> {
	const row = await db
		.selectFrom("preview_sessions")
		.innerJoin("workspaces", "workspaces.id", "preview_sessions.workspace_id")
		.select(["preview_sessions.user_id", "preview_sessions.session_id"])
		.where("preview_sessions.token_hash", "=", hashSessionToken(token))
		.where("preview_sessions.preview_host", "=", host)
		.where("preview_sessions.revoked_at", "is not", null)
		.whereRef("workspaces.owner_user_id", "=", "preview_sessions.user_id")
		.where("workspaces.state", "!=", "running")
		.executeTakeFirst();
	if (!row) return false;
	// A student who has signed out is told to sign in, not about the workspace.
	const user = await loadMainSessionUser(db, row.session_id);
	return user?.id === row.user_id;
}

/**
 * The user behind a main session row, found by its id rather than its token:
 * the preview host never sees the main session cookie, so the preview session
 * carries the id instead. The same rules as `loadSession` (SPEC.md §5.3).
 */
export async function loadMainSessionUser(
	db: Kysely<Database>,
	sessionId: string,
): Promise<AuthUser | null> {
	return loadSessionById(db, sessionId);
}

/** End one preview session. */
export async function revokePreviewSession(
	db: Kysely<Database>,
	id: string,
): Promise<void> {
	await db
		.updateTable("preview_sessions")
		.set({ revoked_at: new Date().toISOString() })
		.where("id", "=", id)
		.where("revoked_at", "is", null)
		.execute();
}

/** End every preview session of one workspace (stop, delete, reset). */
export async function revokeWorkspacePreviewSessions(
	db: Kysely<Database>,
	workspaceId: string,
): Promise<void> {
	await db
		.updateTable("preview_sessions")
		.set({ revoked_at: new Date().toISOString() })
		.where("workspace_id", "=", workspaceId)
		.where("revoked_at", "is", null)
		.execute();
}

/** End every preview session that lives with one main session (logout). */
export async function revokeSessionPreviewSessions(
	db: Kysely<Database>,
	sessionToken: string,
): Promise<void> {
	await db
		.updateTable("preview_sessions")
		.set({ revoked_at: new Date().toISOString() })
		.where("session_id", "=", hashSessionToken(sessionToken))
		.where("revoked_at", "is", null)
		.execute();
}

export interface PreviewWorkspaceRow {
	id: string;
	label: string;
	state: string;
	owner_user_id: string;
	agent_address: string | null;
}

/** The three rows `/preview/authorize` needs; any may be missing. */
export interface PreviewLookup {
	session: PreviewSessionRow | null;
	user: AuthUser | null;
	workspace: PreviewWorkspaceRow | null;
}

/** How long a found set of rows is reused (docs/EPIC-17.md rulings 10 and 11). */
export const PREVIEW_LOOKUP_TTL_MS = 2000;
export const PREVIEW_LOOKUP_MAX_ENTRIES = 10_000;

/**
 * Remember the rows behind a preview cookie for two seconds, so a page of
 * hundreds of assets costs three queries rather than three per asset. Only
 * the rows are kept, never a decision: the caller runs every check on them
 * each time. A lookup missing any row is not kept, so a made-up or revoked
 * cookie always goes to the database. Sign-out, a stop and a session gate
 * therefore reach the gateway up to two seconds late.
 */
export function createPreviewLookupCache(
	db: Kysely<Database>,
	now: () => number = Date.now,
) {
	const entries = new Map<string, { at: number; lookup: PreviewLookup }>();

	async function load(token: string): Promise<PreviewLookup> {
		const session = await loadPreviewSession(db, token);
		if (!session) return { session: null, user: null, workspace: null };
		const user = await loadMainSessionUser(db, session.session_id);
		if (!user) return { session, user: null, workspace: null };
		const workspace =
			(await db
				.selectFrom("workspaces")
				.select(["id", "label", "state", "owner_user_id", "agent_address"])
				.where("id", "=", session.workspace_id)
				.executeTakeFirst()) ?? null;
		return { session, user, workspace };
	}

	return {
		async get(token: string): Promise<PreviewLookup> {
			const key = hashSessionToken(token);
			const at = now();
			const hit = entries.get(key);
			if (hit && at - hit.at < PREVIEW_LOOKUP_TTL_MS) return hit.lookup;
			if (hit) entries.delete(key);

			const lookup = await load(token);
			if (!lookup.session || !lookup.user || !lookup.workspace) return lookup;
			// Map order is insertion order, so the oldest entries come first.
			for (const [k, entry] of entries) {
				if (
					at - entry.at < PREVIEW_LOOKUP_TTL_MS &&
					entries.size < PREVIEW_LOOKUP_MAX_ENTRIES
				) {
					break;
				}
				entries.delete(k);
			}
			entries.set(key, { at, lookup });
			return lookup;
		},
		/** Forget everything, after a revocation made in this process. */
		clear(): void {
			entries.clear();
		},
		/** How many entries are held; for tests. */
		get size(): number {
			return entries.size;
		},
	};
}
