import * as crypto from "node:crypto";
import type { Database } from "@portikus/db";
import { type Kysely, sql } from "kysely";
import type { AuthUser, Role } from "./types.js";

export interface OidcIdentity {
	issuer: string;
	subject: string;
	email: string | null;
	displayName: string;
	/** The `preferred_username` claim; the workspace label comes from it. */
	preferredUsername: string | null;
}

/** The cookie holds the token; the database only ever sees this hash, the session's id. */
export function hashSessionToken(token: string): string {
	return crypto.createHash("sha256").update(token).digest("hex");
}

/** How a session started (docs/EPIC-13-1.md ruling 21). */
export type SessionMethod = "oidc" | "lti" | "link";

export interface SessionOrigin {
	method: SessionMethod;
	/** The linked course identity that launched an 'lti' session, else null. */
	courseUserId: string | null;
}

/**
 * Create the user on first login, otherwise refresh the profile and the
 * provider's role. `role` is the role this sign-in gave; it is stored as
 * `provider_role`, and `users.role` becomes the effective role with any
 * stored grant (ruling 20). `previousRole` is the effective role before this
 * login, or null for a new user, so a role change can be audited.
 */
export async function upsertUser(
	db: Kysely<Database>,
	identity: OidcIdentity,
	role: Role,
): Promise<AuthUser & { disabledAt: string | null; previousRole: Role | null }> {
	const now = new Date().toISOString();
	const previous = await db
		.selectFrom("users")
		.select("role")
		.where("oidc_issuer", "=", identity.issuer)
		.where("oidc_subject", "=", identity.subject)
		.executeTakeFirst();
	const row = await db
		.insertInto("users")
		.values({
			oidc_issuer: identity.issuer,
			oidc_subject: identity.subject,
			email: identity.email,
			display_name: identity.displayName,
			preferred_username: identity.preferredUsername,
			role,
			provider_role: role,
			last_login_at: now,
			updated_at: now,
		})
		.onConflict((oc) =>
			oc.columns(["oidc_issuer", "oidc_subject"]).doUpdateSet({
				email: identity.email,
				display_name: identity.displayName,
				preferred_username: identity.preferredUsername,
				provider_role: role,
				// In SQL so a grant written concurrently is never overwritten by a stale read.
				role: sql<string>`case
					when users.granted_role = 'administrator' or excluded.provider_role = 'administrator' then 'administrator'
					when users.granted_role = 'instructor' or excluded.provider_role = 'instructor' then 'instructor'
					else 'student' end`,
				last_login_at: now,
				updated_at: now,
			}),
		)
		.returning(["id", "email", "display_name", "role", "disabled_at"])
		.executeTakeFirstOrThrow();

	return {
		id: row.id,
		email: row.email,
		displayName: row.display_name,
		role: row.role as Role,
		disabledAt:
			row.disabled_at === null ? null : new Date(row.disabled_at).toISOString(),
		previousRole: previous ? (previous.role as Role) : null,
	};
}

export async function createSession(
	db: Kysely<Database>,
	userId: string,
	ttlSeconds: number,
	origin: SessionOrigin,
): Promise<{ token: string; expiresAt: Date }> {
	// No sweeper process: every new session clears the expired rows.
	await db.deleteFrom("sessions").where("expires_at", "<", new Date()).execute();

	const token = crypto.randomBytes(32).toString("base64url");
	const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

	await db
		.insertInto("sessions")
		.values({
			id: hashSessionToken(token),
			user_id: userId,
			expires_at: expiresAt.toISOString(),
			method: origin.method,
			course_user_id: origin.courseUserId,
		})
		.execute();

	return { token, expiresAt };
}

/**
 * Resolve a session token to its user. Returns null when the session is
 * unknown or expired, when the account has been disabled, or when it is a
 * course account retired by a link (docs/EPIC-13-1.md ruling 13), so that
 * revoking access takes effect on the next request (SPEC.md section 5.3).
 * A launch session also dies once its account is an administrator, however
 * the role arrived (ruling 21).
 */
export async function loadSession(
	db: Kysely<Database>,
	token: string,
): Promise<AuthUser | null> {
	const id = hashSessionToken(token);
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
		.where("sessions.id", "=", id)
		.where((eb) =>
			eb.or([
				eb("sessions.method", "<>", "lti"),
				eb("users.role", "<>", "administrator"),
			]),
		)
		.where(({ not, exists, selectFrom }) =>
			not(
				exists(
					selectFrom("account_links")
						.select("account_links.course_user_id")
						.whereRef("account_links.course_user_id", "=", "users.id"),
				),
			),
		)
		.executeTakeFirst();

	if (!row) {
		return null;
	}

	if (new Date(row.expires_at).getTime() <= Date.now()) {
		await db.deleteFrom("sessions").where("id", "=", id).execute();
		return null;
	}

	if (row.disabled_at !== null) {
		return null;
	}

	return {
		id: row.user_id,
		email: row.email,
		displayName: row.display_name,
		role: row.role as Role,
	};
}

export async function deleteSession(
	db: Kysely<Database>,
	token: string,
): Promise<void> {
	await db.deleteFrom("sessions").where("id", "=", hashSessionToken(token)).execute();
}

/** How the session with this id started, or null when there is none. */
export async function sessionOrigin(
	db: Kysely<Database>,
	sessionId: string,
): Promise<SessionOrigin | null> {
	const row = await db
		.selectFrom("sessions")
		.select(["method", "course_user_id"])
		.where("id", "=", sessionId)
		.executeTakeFirst();
	if (!row) return null;
	return { method: row.method as SessionMethod, courseUserId: row.course_user_id };
}
