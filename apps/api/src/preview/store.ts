import * as crypto from "node:crypto";
import type { AuthUser, PreviewPresentation } from "@portikus/contracts";
import type { Database } from "@portikus/db";
import { type Kysely, sql } from "kysely";

/**
 * Bootstrap tickets and preview sessions (BROWSER-HANDLING.md §9.1, §9.2,
 * §17). Only the hash of a ticket or a preview token is ever stored, the same
 * way the main session does it.
 */
export function hashToken(token: string): string {
	return crypto.createHash("sha256").update(token).digest("hex");
}

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
			ticket_hash: hashToken(ticket),
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
		.where("ticket_hash", "=", hashToken(ticket))
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

/** Start a preview session and return the clear-text cookie value. */
export async function createPreviewSession(
	db: Kysely<Database>,
	input: PreviewSessionInput,
): Promise<string> {
	const token = newToken();
	await db
		.insertInto("preview_sessions")
		.values({
			token_hash: hashToken(token),
			user_id: input.userId,
			session_id: input.sessionId,
			workspace_id: input.workspaceId,
			port: input.port,
			preview_host: input.previewHost,
		})
		.execute();
	return token;
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
		.where("token_hash", "=", hashToken(token))
		.where("revoked_at", "is", null)
		.executeTakeFirst();
	return row ?? null;
}

/**
 * The user behind a main session row, found by its id rather than its token:
 * the preview host never sees the main session cookie, so the preview session
 * carries the id instead. Mirrors `loadSession` (SPEC.md §5.3).
 */
export async function loadMainSessionUser(
	db: Kysely<Database>,
	sessionId: string,
): Promise<AuthUser | null> {
	const row = await db
		.selectFrom("sessions")
		.innerJoin("users", "users.id", "sessions.user_id")
		.select([
			"sessions.expires_at",
			"users.id as user_id",
			"users.email",
			"users.display_name",
			"users.role",
			"users.disabled_at",
		])
		.where("sessions.id", "=", sessionId)
		.executeTakeFirst();
	if (!row) return null;
	if (new Date(row.expires_at).getTime() <= Date.now()) return null;
	if (row.disabled_at !== null) return null;
	return {
		id: row.user_id,
		email: row.email,
		displayName: row.display_name,
		role: row.role as AuthUser["role"],
	};
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
		.where("session_id", "=", hashToken(sessionToken))
		.where("revoked_at", "is", null)
		.execute();
}
