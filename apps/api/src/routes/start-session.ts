import {
	type AuthOptions,
	createSession,
	type Role,
	sessionCookieName,
	sessionCookieOptions,
	upsertUser,
} from "@portikus/auth";
import type { Database } from "@portikus/db";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Kysely } from "kysely";

/**
 * Create a server-side session and set its cookie. Both sign-in paths, the
 * OIDC callback and the LTI launch, end here (docs/EPIC-13.md ruling 3).
 */
export async function startSession(
	db: Kysely<Database>,
	auth: AuthOptions,
	reply: FastifyReply,
	userId: string,
): Promise<void> {
	const session = await createSession(db, userId, auth.sessionTtlSeconds);
	reply.setCookie(sessionCookieName(auth), session.token, {
		...sessionCookieOptions(auth),
		expires: session.expiresAt,
	});
}

/** The client address and browser every sign-in audit row carries. */
export function requestMetadata(request: FastifyRequest): Record<string, unknown> {
	return { ip: request.ip, userAgent: request.headers["user-agent"] ?? null };
}

export interface SignInInput {
	identity: Parameters<typeof upsertUser>[1];
	role: Role;
	/** Metadata for the `auth.login` row, ok or denied. */
	loginMetadata: Record<string, unknown>;
	/** Extra metadata for a `user.role_changed` row beyond from and to. */
	roleChangeMetadata?: Record<string, unknown>;
}

/**
 * The shared tail of both sign-in paths: upsert the user, record a role
 * change, refuse a disabled user, else start the session. Each path writes
 * its own response; this writes the audit rows.
 */
export async function completeSignIn(
	db: Kysely<Database>,
	auth: AuthOptions,
	reply: FastifyReply,
	input: SignInInput,
): Promise<{ ok: boolean; userId: string }> {
	const { identity, role, loginMetadata } = input;
	const user = await upsertUser(db, identity, role);
	// `role` is what the provider gave; the audit follows the effective role (ruling 20).
	if (user.previousRole !== null && user.previousRole !== user.role) {
		// Roles come from identity-provider groups or LTI roles (SPEC.md §24.11).
		await audit(db, "user.role_changed", "identity-provider", user.id, "ok", {
			from: user.previousRole,
			to: user.role,
			...input.roleChangeMetadata,
		});
	}
	if (user.disabledAt) {
		await audit(db, "auth.login", `user:${user.id}`, user.id, "denied", loginMetadata);
		return { ok: false, userId: user.id };
	}
	await startSession(db, auth, reply, user.id);
	await audit(db, "auth.login", `user:${user.id}`, user.id, "ok", loginMetadata);
	return { ok: true, userId: user.id };
}

/** Write one audit row; the caller keeps secrets and personal data out of `metadata`. */
export async function audit(
	db: Kysely<Database>,
	action: string,
	actor: string,
	target: string,
	result: string,
	metadata: Record<string, unknown>,
): Promise<void> {
	await db
		.insertInto("audit_events")
		.values({ actor, target, action, result, metadata: JSON.stringify(metadata) })
		.execute();
}
