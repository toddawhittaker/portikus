import * as crypto from "node:crypto";
import type { Database } from "@portikus/db";
import type { Kysely } from "kysely";
import type { AuthUser, Role } from "./types.js";
import { SESSION_COOKIE } from "./types.js";

export interface OidcIdentity {
	issuer: string;
	subject: string;
	email: string | null;
	displayName: string;
}

/** The cookie holds the token; the database only ever sees this hash. */
function hashToken(token: string): string {
	return crypto.createHash("sha256").update(token).digest("hex");
}

/**
 * Create the user on first login, otherwise refresh the profile and role
 * snapshot taken from the identity provider.
 */
export async function upsertUser(
	db: Kysely<Database>,
	identity: OidcIdentity,
	role: Role,
): Promise<AuthUser> {
	const now = new Date().toISOString();
	const row = await db
		.insertInto("users")
		.values({
			oidc_issuer: identity.issuer,
			oidc_subject: identity.subject,
			email: identity.email,
			display_name: identity.displayName,
			role,
			last_login_at: now,
			updated_at: now,
		})
		.onConflict((oc) =>
			oc.columns(["oidc_issuer", "oidc_subject"]).doUpdateSet({
				email: identity.email,
				display_name: identity.displayName,
				role,
				last_login_at: now,
				updated_at: now,
			}),
		)
		.returning(["id", "email", "display_name", "role"])
		.executeTakeFirstOrThrow();

	return {
		id: row.id,
		email: row.email,
		displayName: row.display_name,
		role: row.role as Role,
	};
}

export async function createSession(
	db: Kysely<Database>,
	userId: string,
	ttlSeconds: number,
): Promise<{ token: string; expiresAt: Date }> {
	const token = crypto.randomBytes(32).toString("base64url");
	const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

	await db
		.insertInto("sessions")
		.values({
			id: hashToken(token),
			user_id: userId,
			expires_at: expiresAt.toISOString(),
		})
		.execute();

	return { token, expiresAt };
}

/**
 * Resolve a session token to its user. Returns null when the session is
 * unknown or expired, or when the account has been disabled, so that
 * revoking access takes effect on the next request (SPEC.md section 5.3).
 */
export async function loadSession(
	db: Kysely<Database>,
	token: string,
): Promise<AuthUser | null> {
	const id = hashToken(token);
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
	await db.deleteFrom("sessions").where("id", "=", hashToken(token)).execute();
}

/** One cookie out of a raw Cookie header, without the Fastify request context. */
function readCookie(header: string, name: string): string | null {
	for (const part of header.split(";")) {
		const separator = part.indexOf("=");
		if (separator > 0 && part.slice(0, separator).trim() === name) {
			return decodeURIComponent(part.slice(separator + 1).trim());
		}
	}
	return null;
}

/** Convenience for contexts that have a raw Cookie header, such as a WebSocket upgrade. */
export async function loadSessionFromCookieHeader(
	db: Kysely<Database>,
	cookieHeader: string | undefined,
): Promise<AuthUser | null> {
	if (!cookieHeader) {
		return null;
	}
	const token = readCookie(cookieHeader, SESSION_COOKIE);
	if (!token) {
		return null;
	}
	return loadSession(db, token);
}
