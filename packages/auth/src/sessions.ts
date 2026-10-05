import { randomBytes } from "node:crypto";
import type { Database } from "@portikus/db";
import { type Kysely, sql } from "kysely";
import { dexLocalUserId } from "./dex-subject.js";
import { sha256Hex } from "./hash.js";
import { secondFactorApplies } from "./second-factor.js";
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
	return sha256Hex(token);
}

/** How a session started (ADR 0026). */
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
 * stored grant. `previousRole` is the effective role before this
 * login, or null for a new user, so a role change can be audited.
 */
export async function upsertUser(
	db: Kysely<Database>,
	identity: OidcIdentity,
	role: Role,
): Promise<
	// Acceptance and the second factor are the session's business; loadSession decides them.
	Omit<AuthUser, "mustAcceptUse" | "secondFactor" | "secondFactorApplies"> & {
		disabledAt: string | null;
		previousRole: Role | null;
	}
> {
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
				// A Dex password's name is its username, so keep the stored display name then.
				display_name: sql<string>`case
					when excluded.display_name = users.preferred_username then users.display_name
					else excluded.display_name end`,
				// Dex sends none for a password made through its API, so keep the stored one.
				preferred_username: sql<
					string | null
				>`coalesce(excluded.preferred_username, users.preferred_username)`,
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
		.returning([
			"id",
			"email",
			"display_name",
			"role",
			"disabled_at",
			"must_change_password",
		])
		.executeTakeFirstOrThrow();

	return {
		id: row.id,
		email: row.email,
		displayName: row.display_name,
		role: row.role as Role,
		mustChangePassword: row.must_change_password,
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

	const token = randomBytes(32).toString("base64url");
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
 * How long a session may rely on an administrator or instructor role that
 * the identity provider gave, so a role removed there takes effect within
 * this bound (SPEC.md section 24.13).
 */
export const ELEVATED_SESSION_MAX_SECONDS = 3600;

/**
 * True when the session's elevated role came from the identity provider's
 * groups, not from a Portikus grant (a lower grant does not count). Launch sessions take their role from
 * the launch, and Dex local-password accounts get theirs from Portikus.
 */
export function roleFromProvider(row: {
	role: string;
	granted_role: string | null;
	method: string;
	oidc_subject: string;
}): boolean {
	return (
		row.role !== "student" &&
		// The effective role is the higher of grant and provider role.
		row.granted_role !== row.role &&
		row.method !== "lti" &&
		dexLocalUserId(row.oidc_subject) === null
	);
}

/**
 * Resolve a session token to its user. Returns null when the session is
 * unknown or expired, when the account has been disabled, or when it is a
 * course account retired by a link (ADR 0026), so that
 * revoking access takes effect on the next request (SPEC.md section 5.3).
 * A launch session also dies once its account is an administrator, however
 * the role arrived.
 */
export async function loadSession(
	db: Kysely<Database>,
	token: string,
): Promise<AuthUser | null> {
	return loadSessionById(db, hashSessionToken(token));
}

/**
 * `loadSession` by the session's id, the token's hash. The preview gateway
 * holds only the id, and must apply the same rules.
 */
export async function loadSessionById(
	db: Kysely<Database>,
	id: string,
): Promise<AuthUser | null> {
	const row = await db
		.selectFrom("sessions")
		.innerJoin("users", "users.id", "sessions.user_id")
		.leftJoin("settings", (join) => join.on("settings.id", "=", 1))
		.select([
			"sessions.expires_at",
			"users.id as user_id",
			"users.email",
			"users.display_name",
			"users.role",
			"users.granted_role",
			"sessions.created_at",
			"users.disabled_at",
			"users.must_change_password",
			"users.acceptable_use_version as accepted_use_version",
			"settings.acceptable_use_version as current_use_version",
			"users.oidc_issuer",
			"users.oidc_subject",
			"sessions.method",
			"sessions.second_factor_at",
		])
		.select((eb) =>
			eb
				.exists(
					eb
						.selectFrom("user_second_factors")
						.select("user_second_factors.id")
						.whereRef("user_second_factors.user_id", "=", "users.id"),
				)
				.as("has_second_factor"),
		)
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
		// A launch session dies with its link, even one resolved just before an unlink.
		.where((eb) =>
			eb.or([
				eb("sessions.method", "<>", "lti"),
				eb("sessions.course_user_id", "is", null),
				eb.exists(
					eb
						.selectFrom("account_links as own_link")
						.select("own_link.course_user_id")
						.whereRef("own_link.course_user_id", "=", "sessions.course_user_id")
						.whereRef("own_link.user_id", "=", "sessions.user_id"),
				),
			]),
		)
		.executeTakeFirst();

	if (!row) {
		return null;
	}

	const ended =
		new Date(row.expires_at).getTime() <= Date.now() ||
		(roleFromProvider(row) &&
			Date.now() - new Date(row.created_at).getTime() >=
				ELEVATED_SESSION_MAX_SECONDS * 1000);
	if (ended) {
		await db.deleteFrom("sessions").where("id", "=", id).execute();
		return null;
	}

	if (row.disabled_at !== null) {
		return null;
	}

	const applies = secondFactorApplies(row);
	return {
		id: row.user_id,
		email: row.email,
		displayName: row.display_name,
		role: row.role as Role,
		mustChangePassword: row.must_change_password,
		// No settings row yet means version 1, the column default.
		mustAcceptUse: row.accepted_use_version !== (row.current_use_version ?? 1),
		secondFactor:
			row.second_factor_at !== null || !applies
				? null
				: row.has_second_factor
					? "verify"
					: "enrol",
		secondFactorApplies: applies,
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
