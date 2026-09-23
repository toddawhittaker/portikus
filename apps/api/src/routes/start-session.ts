import {
	type AuthOptions,
	createSession,
	sessionCookieName,
	sessionCookieOptions,
} from "@portikus/auth";
import type { Database } from "@portikus/db";
import type { FastifyReply } from "fastify";
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
