import * as crypto from "node:crypto";
import { hashSessionToken, loadSessionById } from "@portikus/auth";
import type { PreviewPresentation } from "@portikus/contracts";
import type { Database } from "@portikus/db";
import { type Kysely, sql } from "kysely";

/** The session user with its gate state, as `loadSessionById` gives it. */
type SessionUser = NonNullable<Awaited<ReturnType<typeof loadSessionById>>>;

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
	/** Set when an instructor opens the preview through live help (ADR 0063). */
	liveHelpSessionId?: string;
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
			live_help_session_id: input.liveHelpSessionId ?? null,
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
async function sweepDeadPreviewSessions(db: Kysely<Database>): Promise<void> {
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
	live_help_session_id: string | null;
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
			"live_help_session_id",
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
	liveHelpSessionId?: string | null;
}

/**
 * How many live preview sessions one student may hold at once. A preview
 * session already dies with the main Portikus session, but nothing bounded
 * how many one main session could pile up, so a page opening previews in a
 * loop could grow the table without limit. Fifty is far above real use: a
 * student opens a handful of ports.
 */
const MAX_PREVIEW_SESSIONS_PER_USER = 50;

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
			live_help_session_id: input.liveHelpSessionId ?? null,
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
	live_help_session_id: string | null;
}

/** The live preview session behind a cookie, or null when it cannot be used. */
export async function loadPreviewSession(
	db: Kysely<Database>,
	token: string,
): Promise<PreviewSessionRow | null> {
	const row = await db
		.selectFrom("preview_sessions")
		.select([
			"id",
			"user_id",
			"session_id",
			"workspace_id",
			"port",
			"preview_host",
			"live_help_session_id",
		])
		.where("token_hash", "=", hashSessionToken(token))
		.where("revoked_at", "is", null)
		.executeTakeFirst();
	return row ?? null;
}

/**
 * Whether any preview session, revoked or not, was ever issued for this
 * cookie. A cookie with none was made up (SPEC.md section 24.13).
 */
export async function previewTokenIssued(
	db: Kysely<Database>,
	token: string,
): Promise<boolean> {
	const row = await db
		.selectFrom("preview_sessions")
		.select("id")
		.where("token_hash", "=", hashSessionToken(token))
		.executeTakeFirst();
	return row !== undefined;
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
): Promise<SessionUser | null> {
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

interface PreviewWorkspaceRow {
	id: string;
	label: string;
	state: string;
	owner_user_id: string;
	agent_address: string | null;
}

/** The live help session an instructor's preview rides on (ADR 0063). */
interface PreviewLiveHelpRow {
	workspace_id: string;
	helper_user_id: string;
	ends_at: Date;
	ended_at: Date | null;
}

/** The rows `/preview/authorize` needs; any may be missing. */
export interface PreviewLookup {
	session: PreviewSessionRow | null;
	user: SessionUser | null;
	workspace: PreviewWorkspaceRow | null;
	/** Present only for a preview opened through live help. */
	liveHelp: PreviewLiveHelpRow | null;
}

/**
 * Who a preview session lets in: the workspace's owner, or the helper of an
 * open live help session on this workspace (ADR 0063). The owner check is
 * widened only that way; anything else is null.
 */
export function previewAccess(
	lookup: Pick<PreviewLookup, "session" | "workspace" | "liveHelp">,
	now: number = Date.now(),
): "owner" | "helper" | null {
	const { session, workspace, liveHelp } = lookup;
	if (!session || !workspace) return null;
	if (!session.live_help_session_id) {
		return workspace.owner_user_id === session.user_id ? "owner" : null;
	}
	const open =
		liveHelp !== null &&
		liveHelp.ended_at === null &&
		new Date(liveHelp.ends_at).getTime() > now &&
		liveHelp.helper_user_id === session.user_id &&
		liveHelp.workspace_id === workspace.id &&
		session.workspace_id === workspace.id;
	return open ? "helper" : null;
}

/** Every lookup cache in this process, so ending live help can clear them all. */
const liveCaches = new Set<{ clear(): void }>();

/** Forget every cached preview lookup, after a revocation made in this process. */
export function clearPreviewLookups(): void {
	for (const cache of liveCaches) cache.clear();
}

/** How long a found set of rows is reused (ADR 0034 rulings 10 and 11). */
export const PREVIEW_LOOKUP_TTL_MS = 2000;
const PREVIEW_LOOKUP_MAX_ENTRIES = 10_000;

/**
 * Remember the rows behind a preview cookie for two seconds, so a page of
 * hundreds of assets costs three queries rather than three per asset. Only
 * the rows are kept, never a decision: the caller runs every check on them
 * each time. A lookup missing any row is not kept, so a made-up or revoked
 * cookie always goes to the database. Any removal of authorization (sign-out,
 * account disable, session expiry, workspace stop or delete, a session gate)
 * therefore reaches the gateway up to two seconds late.
 */
export function createPreviewLookupCache(
	db: Kysely<Database>,
	now: () => number = Date.now,
) {
	const entries = new Map<string, { at: number; lookup: PreviewLookup }>();
	// Bumped by clear() so a lookup that started before it cannot store stale rows.
	let generation = 0;

	async function load(token: string): Promise<PreviewLookup> {
		const session = await loadPreviewSession(db, token);
		if (!session) return { session: null, user: null, workspace: null, liveHelp: null };
		const user = await loadMainSessionUser(db, session.session_id);
		if (!user) return { session, user: null, workspace: null, liveHelp: null };
		const workspace =
			(await db
				.selectFrom("workspaces")
				.select(["id", "label", "state", "owner_user_id", "agent_address"])
				.where("id", "=", session.workspace_id)
				.executeTakeFirst()) ?? null;
		const liveHelp = session.live_help_session_id
			? ((await db
					.selectFrom("live_help_sessions")
					.select(["workspace_id", "helper_user_id", "ends_at", "ended_at"])
					.where("id", "=", session.live_help_session_id)
					.executeTakeFirst()) ?? null)
			: null;
		return { session, user, workspace, liveHelp };
	}

	const cache = {
		async get(token: string): Promise<PreviewLookup> {
			const key = hashSessionToken(token);
			const at = now();
			const hit = entries.get(key);
			if (hit && at - hit.at < PREVIEW_LOOKUP_TTL_MS) return hit.lookup;
			if (hit) entries.delete(key);

			const started = generation;
			const lookup = await load(token);
			if (!lookup.session || !lookup.user || !lookup.workspace) return lookup;
			if (started !== generation) return lookup;
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
			generation += 1;
			entries.clear();
		},
		/** How many entries are held; for tests. */
		get size(): number {
			return entries.size;
		},
	};
	liveCaches.add(cache);
	return cache;
}
