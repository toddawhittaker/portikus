import { createHash } from "node:crypto";
import type { Database } from "@portikus/db";
import { type Kysely, sql } from "kysely";
import type { SessionMethod, SessionOrigin } from "./sessions.js";
import type { Role } from "./types.js";

/**
 * Account links and the stored role grant (docs/EPIC-13-1.md, "The data
 * model" and rulings 10 to 23). Identities are looked up only by (issuer,
 * `sub`), never by email or username. Functions that change several rows
 * take the caller's transaction, so the caller's audit rows commit with them.
 */

/** A course session may start or confirm a link this long after its launch (ruling 10). */
export const LINK_WINDOW_SECONDS = 15 * 60;

/** How long a link intent lives between start and callback. */
export const LINK_INTENT_TTL_SECONDS = 10 * 60;

const LTI_PREFIX = "lti:";

function hashState(state: string): string {
	return createHash("sha256").update(state).digest("hex");
}

/** True for a course account's issuer, `lti:<platform issuer>` (EPIC-13 ruling 12). */
export function isCourseIssuer(issuer: string): boolean {
	return issuer.startsWith(LTI_PREFIX);
}

/** The plain platform issuer of a course account's issuer. */
export function platformIssuerOf(issuer: string): string {
	return issuer.slice(LTI_PREFIX.length);
}

export interface LinkWindow {
	courseUserId: string;
	linkUntil: Date;
	open: boolean;
}

/**
 * How a session started and its link window, from one read of the session
 * row. The window is set only when the session belongs to an unlinked
 * course account; `open` is false once it has passed.
 */
export async function sessionLinkState(
	db: Kysely<Database>,
	sessionId: string,
	now: Date = new Date(),
): Promise<{ origin: SessionOrigin; window: LinkWindow | null } | null> {
	const row = await db
		.selectFrom("sessions")
		.innerJoin("users", "users.id", "sessions.user_id")
		.leftJoin("account_links", "account_links.course_user_id", "users.id")
		.select([
			"users.id",
			"users.oidc_issuer",
			"sessions.created_at",
			"sessions.method",
			"sessions.course_user_id",
			"account_links.course_user_id as linked",
		])
		.where("sessions.id", "=", sessionId)
		.executeTakeFirst();
	if (!row) return null;
	const origin: SessionOrigin = {
		method: row.method as SessionMethod,
		courseUserId: row.course_user_id,
	};
	if (!isCourseIssuer(row.oidc_issuer) || row.linked !== null) {
		return { origin, window: null };
	}
	const linkUntil = new Date(
		new Date(row.created_at).getTime() + LINK_WINDOW_SECONDS * 1000,
	);
	return { origin, window: { courseUserId: row.id, linkUntil, open: now < linkUntil } };
}

/** The link window of a session; see `sessionLinkState`. */
export async function courseLinkWindow(
	db: Kysely<Database>,
	sessionId: string,
	now: Date = new Date(),
): Promise<LinkWindow | null> {
	return (await sessionLinkState(db, sessionId, now))?.window ?? null;
}

/**
 * Store a link intent for this session under the hash of the OIDC state,
 * replacing any earlier one of the session and clearing expired rows.
 */
export async function saveLinkIntent(
	db: Kysely<Database>,
	input: { state: string; sessionId: string; courseUserId: string },
	now: Date = new Date(),
): Promise<void> {
	await db.deleteFrom("account_link_intents").where("expires_at", "<=", now).execute();
	const row = {
		state_hash: hashState(input.state),
		course_user_id: input.courseUserId,
		user_id: null,
		expires_at: new Date(now.getTime() + LINK_INTENT_TTL_SECONDS * 1000).toISOString(),
	};
	await db
		.insertInto("account_link_intents")
		.values({ ...row, session_id: input.sessionId })
		.onConflict((oc) => oc.column("session_id").doUpdateSet(row))
		.execute();
}

export interface LinkIntent {
	sessionId: string;
	courseUserId: string;
	/** The SSO account, once the callback has bound it. */
	userId: string | null;
	expiresAt: Date;
}

/** The intent stored under this OIDC state, or null: null means an ordinary sign-in. */
export async function findLinkIntent(
	db: Kysely<Database>,
	state: string,
): Promise<LinkIntent | null> {
	const row = await db
		.selectFrom("account_link_intents")
		.select(["session_id", "course_user_id", "user_id", "expires_at"])
		.where("state_hash", "=", hashState(state))
		.executeTakeFirst();
	if (!row) return null;
	return {
		sessionId: row.session_id,
		courseUserId: row.course_user_id,
		userId: row.user_id,
		expiresAt: new Date(row.expires_at),
	};
}

/**
 * Bind the SSO account to an intent, only for the session that made it,
 * only once, and only before it expires. Returns `expired` when no such
 * intent is left (ruling 18), or null when bound. The callback has already
 * refused a different session with `session_changed`.
 */
export async function bindLinkIntent(
	db: Kysely<Database>,
	input: { state: string; sessionId: string; userId: string },
	now: Date = new Date(),
): Promise<"expired" | null> {
	const bound = await db
		.updateTable("account_link_intents")
		.set({ user_id: input.userId })
		.where("state_hash", "=", hashState(input.state))
		.where("session_id", "=", input.sessionId)
		.where("user_id", "is", null)
		.where("expires_at", ">", now)
		.executeTakeFirst();
	return bound.numUpdatedRows === 1n ? null : "expired";
}

/** This session's bound intent, for the confirmation page; the row stays. */
export async function pendingLinkIntent(
	db: Kysely<Database>,
	sessionId: string,
	now: Date = new Date(),
): Promise<{ courseUserId: string; userId: string } | null> {
	const row = await db
		.selectFrom("account_link_intents")
		.select(["course_user_id", "user_id"])
		.where("session_id", "=", sessionId)
		.where("user_id", "is not", null)
		.where("expires_at", ">", now)
		.executeTakeFirst();
	if (!row || row.user_id === null) return null;
	return { courseUserId: row.course_user_id, userId: row.user_id };
}

/**
 * Delete and return this session's bound, unexpired intent. One DELETE ...
 * RETURNING, so an intent confirms at most once.
 */
export async function consumeLinkIntent(
	db: Kysely<Database>,
	sessionId: string,
	now: Date = new Date(),
): Promise<{ courseUserId: string; userId: string } | null> {
	const row = await db
		.deleteFrom("account_link_intents")
		.where("session_id", "=", sessionId)
		.where("user_id", "is not", null)
		.where("expires_at", ">", now)
		.returning(["course_user_id", "user_id"])
		.executeTakeFirst();
	if (!row || row.user_id === null) return null;
	return { courseUserId: row.course_user_id, userId: row.user_id };
}

export type LinkRefusal =
	| "not_found"
	| "not_course_account"
	| "not_sso_account"
	| "not_authorized"
	| "already_linked";

/**
 * Link a course account to an SSO account (flow step 5). Run inside the
 * confirm transaction. Locks both users rows, inserts the link, archives the
 * course workspace unless it is archived already (ruling 14), moves course
 * memberships (ruling 16), and ends every session and preview session of
 * the course account (ruling 17).
 */
export async function linkAccounts(
	trx: Kysely<Database>,
	input: { courseUserId: string; userId: string },
): Promise<
	| { ok: true; platformIssuer: string; archivedWorkspaceId: string | null }
	| { ok: false; reason: LinkRefusal }
> {
	const users = await trx
		.selectFrom("users")
		.select(["id", "oidc_issuer", "disabled_at", "role"])
		.where("id", "in", [input.courseUserId, input.userId])
		.orderBy("id")
		.forUpdate()
		.execute();
	const course = users.find((u) => u.id === input.courseUserId);
	const sso = users.find((u) => u.id === input.userId);
	if (!course || !sso || course.id === sso.id)
		return { ok: false, reason: "not_found" };
	if (!isCourseIssuer(course.oidc_issuer))
		return { ok: false, reason: "not_course_account" };
	if (isCourseIssuer(sso.oidc_issuer)) return { ok: false, reason: "not_sso_account" };
	// An administrator is never reachable from a launch (review N4).
	if (sso.disabled_at !== null || sso.role === "administrator")
		return { ok: false, reason: "not_authorized" };
	const platformIssuer = platformIssuerOf(course.oidc_issuer);

	const existing = await trx
		.selectFrom("account_links")
		.select("course_user_id")
		.where((eb) =>
			eb.or([
				eb("course_user_id", "=", course.id),
				eb("course_user_id", "=", sso.id),
				eb.and([
					eb("user_id", "=", sso.id),
					eb("platform_issuer", "=", platformIssuer),
				]),
			]),
		)
		.executeTakeFirst();
	if (existing) return { ok: false, reason: "already_linked" };

	const now = new Date().toISOString();
	const archived = await trx
		.updateTable("workspaces")
		.set({ archived_at: now, desired_state: "stopped", updated_at: now })
		.where("owner_user_id", "=", course.id)
		.where("archived_at", "is", null)
		.returning(["id", "archived_at"])
		.executeTakeFirst();

	await trx
		.insertInto("account_links")
		.values({
			course_user_id: course.id,
			user_id: sso.id,
			platform_issuer: platformIssuer,
			// The exact stamp, so unlink undoes only this archive (ruling 15).
			archived_at: archived?.archived_at
				? new Date(archived.archived_at).toISOString()
				: null,
		})
		.execute();

	await sql`insert into lti_memberships (context_id, user_id, role, last_launch_at)
		select context_id, ${sso.id}, role, last_launch_at from lti_memberships
		where user_id = ${course.id}
		on conflict (context_id, user_id) do update
		set role = excluded.role, last_launch_at = excluded.last_launch_at
		where excluded.last_launch_at > lti_memberships.last_launch_at`.execute(trx);
	await trx.deleteFrom("lti_memberships").where("user_id", "=", course.id).execute();

	await trx.deleteFrom("sessions").where("user_id", "=", course.id).execute();

	return { ok: true, platformIssuer, archivedWorkspaceId: archived?.id ?? null };
}

/**
 * Remove the caller's link to a course account (ruling 15). When the link
 * archived the course workspace, unarchive it, leaving it stopped, but only
 * while the workspace still carries that archive and not a later one. Ends
 * every session that came through the course identity, with its preview
 * sessions (review N1). Returns null when the link does not exist or
 * belongs to someone else.
 */
export async function unlinkAccount(
	trx: Kysely<Database>,
	input: { userId: string; courseUserId: string },
): Promise<{ platformIssuer: string; unarchivedWorkspaceId: string | null } | null> {
	const link = await trx
		.deleteFrom("account_links")
		.where("course_user_id", "=", input.courseUserId)
		.where("user_id", "=", input.userId)
		.returning(["platform_issuer", "archived_at"])
		.executeTakeFirst();
	if (!link) return null;
	// Deleting a session cascades to its preview rows.
	await trx
		.deleteFrom("sessions")
		.where("user_id", "=", input.userId)
		.where("course_user_id", "=", input.courseUserId)
		.execute();
	let unarchivedWorkspaceId: string | null = null;
	if (link.archived_at !== null) {
		const now = new Date().toISOString();
		const row = await trx
			.updateTable("workspaces")
			.set({ archived_at: null, updated_at: now })
			.where("owner_user_id", "=", input.courseUserId)
			.where("archived_at", "=", new Date(link.archived_at))
			.returning("id")
			.executeTakeFirst();
		unarchivedWorkspaceId = row?.id ?? null;
	}
	return { platformIssuer: link.platform_issuer, unarchivedWorkspaceId };
}

/**
 * The account an identity signs into. `userId` is the live account: the
 * SSO account when the identity is a linked course account, whose id is
 * then `courseUserId`. Null when no account has this identity.
 */
export async function resolveIdentity(
	db: Kysely<Database>,
	issuer: string,
	subject: string,
): Promise<{ userId: string; courseUserId: string | null } | null> {
	const row = await db
		.selectFrom("users")
		.leftJoin("account_links", "account_links.course_user_id", "users.id")
		.select(["users.id", "account_links.user_id as linked_user_id"])
		.where("users.oidc_issuer", "=", issuer)
		.where("users.oidc_subject", "=", subject)
		.executeTakeFirst();
	if (!row) return null;
	if (row.linked_user_id === null) return { userId: row.id, courseUserId: null };
	return { userId: row.linked_user_id, courseUserId: row.id };
}

/** The course accounts linked to an SSO account, oldest first. */
export async function listLinks(
	db: Kysely<Database>,
	userId: string,
): Promise<
	{
		courseUserId: string;
		platformIssuer: string;
		displayName: string;
		linkedAt: Date;
	}[]
> {
	const rows = await db
		.selectFrom("account_links")
		.innerJoin("users", "users.id", "account_links.course_user_id")
		.select([
			"account_links.course_user_id",
			"account_links.platform_issuer",
			"account_links.created_at",
			"users.display_name",
		])
		.where("account_links.user_id", "=", userId)
		.orderBy("account_links.created_at")
		.execute();
	return rows.map((r) => ({
		courseUserId: r.course_user_id,
		platformIssuer: r.platform_issuer,
		displayName: r.display_name,
		linkedAt: new Date(r.created_at),
	}));
}

export type RoleChange = { from: Role; to: Role };

/**
 * Grant administrator to an SSO account (ruling 23). Run inside the
 * caller's transaction. `changed` is false when the account is already an
 * administrator, in which case nothing is written.
 */
export async function grantAdministrator(
	trx: Kysely<Database>,
	targetId: string,
): Promise<
	| ({ ok: true; changed: boolean } & RoleChange)
	| { ok: false; reason: "not_found" | "course_account" }
> {
	const target = await trx
		.selectFrom("users")
		.select(["oidc_issuer", "role"])
		.where("id", "=", targetId)
		.forUpdate()
		.executeTakeFirst();
	if (!target) return { ok: false, reason: "not_found" };
	if (isCourseIssuer(target.oidc_issuer))
		return { ok: false, reason: "course_account" };
	const from = target.role as Role;
	if (from === "administrator") return { ok: true, changed: false, from, to: from };
	const to: Role = "administrator";
	await trx
		.updateTable("users")
		.set({
			granted_role: "administrator",
			role: to,
			updated_at: new Date().toISOString(),
		})
		.where("id", "=", targetId)
		.execute();
	return { ok: true, changed: true, from, to };
}

/**
 * Remove a granted administrator role (ruling 23). Locks the target and every
 * enabled administrator, in id order, so two administrators demoting each
 * other at once cannot both succeed. Run inside the caller's transaction.
 */
export async function revokeAdministrator(
	trx: Kysely<Database>,
	input: { actorId: string; targetId: string },
): Promise<
	| ({ ok: true } & RoleChange)
	| {
			ok: false;
			reason:
				| "not_found"
				| "self"
				| "provider_administrator"
				| "not_administrator"
				| "last_administrator";
	  }
> {
	if (input.actorId === input.targetId) return { ok: false, reason: "self" };
	const locked = await trx
		.selectFrom("users")
		.select(["id", "role", "provider_role", "granted_role", "disabled_at"])
		.where((eb) =>
			eb.or([
				eb("id", "=", input.targetId),
				eb.and([eb("role", "=", "administrator"), eb("disabled_at", "is", null)]),
			]),
		)
		.orderBy("id")
		.forUpdate()
		.execute();
	const target = locked.find((u) => u.id === input.targetId);
	if (!target) return { ok: false, reason: "not_found" };
	if (target.granted_role !== "administrator") {
		const reason =
			target.role === "administrator" ? "provider_administrator" : "not_administrator";
		return { ok: false, reason };
	}
	const others = locked.filter(
		(u) =>
			u.id !== input.targetId && u.role === "administrator" && u.disabled_at === null,
	);
	if (others.length === 0) return { ok: false, reason: "last_administrator" };
	const to = target.provider_role as Role;
	await trx
		.updateTable("users")
		.set({ granted_role: null, role: to, updated_at: new Date().toISOString() })
		.where("id", "=", input.targetId)
		.execute();
	return { ok: true, from: target.role as Role, to };
}

/**
 * Grant instructor to an SSO account (docs/EPIC-14.md ruling 14). Run inside
 * the caller's transaction. An administrator grant is never touched, and an
 * account already instructor or higher is left as it is (`changed` false).
 */
export async function grantInstructor(
	trx: Kysely<Database>,
	targetId: string,
): Promise<
	| ({ ok: true; changed: boolean } & RoleChange)
	| { ok: false; reason: "not_found" | "course_account" | "granted_administrator" }
> {
	const target = await trx
		.selectFrom("users")
		.select(["oidc_issuer", "role", "granted_role"])
		.where("id", "=", targetId)
		.forUpdate()
		.executeTakeFirst();
	if (!target) return { ok: false, reason: "not_found" };
	if (isCourseIssuer(target.oidc_issuer))
		return { ok: false, reason: "course_account" };
	if (target.granted_role === "administrator")
		return { ok: false, reason: "granted_administrator" };
	const from = target.role as Role;
	if (from !== "student") return { ok: true, changed: false, from, to: from };
	const to: Role = "instructor";
	await trx
		.updateTable("users")
		.set({ granted_role: "instructor", role: to, updated_at: new Date().toISOString() })
		.where("id", "=", targetId)
		.execute();
	return { ok: true, changed: true, from, to };
}

/**
 * Remove a granted instructor role (docs/EPIC-14.md ruling 14): the account
 * falls back to its provider role. Only an instructor grant is removed.
 */
export async function revokeInstructor(
	trx: Kysely<Database>,
	targetId: string,
): Promise<
	({ ok: true } & RoleChange) | { ok: false; reason: "not_found" | "not_granted" }
> {
	const target = await trx
		.selectFrom("users")
		.select(["role", "provider_role", "granted_role"])
		.where("id", "=", targetId)
		.forUpdate()
		.executeTakeFirst();
	if (!target) return { ok: false, reason: "not_found" };
	if (target.granted_role !== "instructor") return { ok: false, reason: "not_granted" };
	const to = target.provider_role as Role;
	await trx
		.updateTable("users")
		.set({ granted_role: null, role: to, updated_at: new Date().toISOString() })
		.where("id", "=", targetId)
		.execute();
	return { ok: true, from: target.role as Role, to };
}
