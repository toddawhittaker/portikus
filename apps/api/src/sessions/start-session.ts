import {
	type AuthOptions,
	createSession,
	dexLocalUserId,
	hashSessionToken,
	type Role,
	type SessionOrigin,
	sessionCookieName,
	sessionCookieOptions,
	upsertUser,
} from "@portikus/auth";
import { type Database, recordAudit } from "@portikus/db";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Kysely } from "kysely";
import { claimInvitation } from "./invitations.js";

/**
 * Create a server-side session and set its cookie. Both sign-in paths, the
 * OIDC callback, the LTI launch and link confirm, end here. The origin records how it started.
 * Returns the session's id, the token's hash.
 */
export async function startSession(
	db: Kysely<Database>,
	auth: AuthOptions,
	reply: FastifyReply,
	userId: string,
	origin: SessionOrigin,
): Promise<string> {
	const session = await createSession(db, userId, auth.sessionTtlSeconds, origin);
	reply.setCookie(sessionCookieName(auth), session.token, {
		...sessionCookieOptions(auth),
		expires: session.expiresAt,
	});
	return hashSessionToken(session.token);
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
	/** The ID token's `email_verified` claim was true; only OIDC sign-ins match invitations by email. */
	emailVerified?: boolean;
}

export type SignInResult =
	| { ok: true; userId: string }
	| { ok: false; reason: "disabled"; userId: string }
	| { ok: false; reason: "not_invited" };

/**
 * Whether this OIDC sign-in may proceed: an existing account, a Dex local
 * password (Add user made it), or a claimed invitation (SPEC.md §24.13).
 * An LTI launch is enrolment by a platform the administrator registered,
 * so it never comes here.
 */
async function admitted(db: Kysely<Database>, input: SignInInput): Promise<boolean> {
	const { identity } = input;
	const existing = await db
		.selectFrom("users")
		.select("id")
		.where("oidc_issuer", "=", identity.issuer)
		.where("oidc_subject", "=", identity.subject)
		.executeTakeFirst();
	if (existing) return true;
	if (dexLocalUserId(identity.subject) !== null) return true;
	const claimed = await claimInvitation(db, {
		identity,
		providerRole: input.role,
		emailVerified: input.emailVerified === true,
	});
	return claimed !== null;
}

/**
 * The shared tail of both sign-in paths: admit or refuse a first OIDC
 * sign-in, upsert the user, record a role change, refuse a disabled user,
 * else start the session. Each path writes its own response; this writes
 * the audit rows.
 */
export async function completeSignIn(
	db: Kysely<Database>,
	auth: AuthOptions,
	reply: FastifyReply,
	input: SignInInput,
): Promise<SignInResult> {
	const { identity, role, loginMetadata } = input;
	if (input.method === "oidc" && !(await admitted(db, input))) {
		// Prefix the subject so a crafted one cannot look like `user:<uuid>`.
		await recordAudit(db, {
			actor: `subject:${identity.subject}`,
			target: identity.subject,
			action: "auth.login",
			result: "denied",
			metadata: { ...loginMetadata, reason: "not_invited" },
		});
		return { ok: false, reason: "not_invited" };
	}
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
		return { ok: false, reason: "disabled", userId: user.id };
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
