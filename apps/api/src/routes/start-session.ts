import {
	type AuthOptions,
	createSession,
	type Role,
	type SessionOrigin,
	sessionCookieName,
	sessionCookieOptions,
	upsertUser,
} from "@portikus/auth";
import { type Database, recordAudit } from "@portikus/db";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Kysely } from "kysely";

/**
 * Create a server-side session and set its cookie. Both sign-in paths, the
 * OIDC callback, the LTI launch and link confirm, end here. The origin records how it started.
 */
export async function startSession(
	db: Kysely<Database>,
	auth: AuthOptions,
	reply: FastifyReply,
	userId: string,
	origin: SessionOrigin,
): Promise<void> {
	const session = await createSession(db, userId, auth.sessionTtlSeconds, origin);
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
	/** Which sign-in path this is; a launch session can never act as an administrator. */
	method: "oidc" | "lti";
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
	// `role` is what the provider gave; the audit follows the effective role.
	if (user.previousRole !== null && user.previousRole !== user.role) {
		// Roles come from identity-provider groups or LTI roles (SPEC.md §24.11).
		await recordAudit(db, {
			actor: "identity-provider",
			target: user.id,
			action: "user.role_changed",
			result: "ok",
			metadata: {
				from: user.previousRole,
				to: user.role,
				...input.roleChangeMetadata,
			},
		});
	}
	if (user.disabledAt) {
		await recordAudit(db, {
			actor: `user:${user.id}`,
			target: user.id,
			action: "auth.login",
			result: "denied",
			metadata: loginMetadata,
		});
		return { ok: false, userId: user.id };
	}
	await startSession(db, auth, reply, user.id, {
		method: input.method,
		courseUserId: null,
	});
	await recordAudit(db, {
		actor: `user:${user.id}`,
		target: user.id,
		action: "auth.login",
		result: "ok",
		metadata: loginMetadata,
	});
	return { ok: true, userId: user.id };
}
