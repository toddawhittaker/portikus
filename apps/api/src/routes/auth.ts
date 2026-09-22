import {
	createSession,
	deleteSession,
	type LoginState,
	loginCookieName,
	loginCookieOptions,
	mapRole,
	OidcError,
	sessionCookieName,
	sessionCookieOptions,
	upsertUser,
} from "@portikus/auth";
import type { ApiError, MeResponse } from "@portikus/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { toAuthOptions } from "../auth-options.js";
import { revokeSessionPreviewSessions } from "../preview/store.js";
import type { ServerDeps } from "../server.js";

const DENIED_MESSAGE = "Your account is not authorized to use Portikus";

/** Login, logout, and the current-user route (SPEC.md §5.1, §5.2, §5.3). */
export function registerAuthRoutes(
	app: FastifyInstance,
	{ db, config, oidc }: ServerDeps,
): void {
	const auth = toAuthOptions(config);
	const sessionCookie = sessionCookieName(auth);
	const loginCookie = loginCookieName(auth);

	async function audit(
		request: FastifyRequest,
		action: string,
		actor: string,
		target: string,
		result: string,
	): Promise<void> {
		await db
			.insertInto("audit_events")
			.values({
				actor,
				target,
				action,
				result,
				metadata: JSON.stringify({
					ip: request.ip,
					userAgent: request.headers["user-agent"] ?? null,
				}),
			})
			.execute();
	}

	function fail(
		reply: FastifyReply,
		status: number,
		code: ApiError["code"],
		message: string,
	) {
		return reply.status(status).send({ code, message });
	}

	app.get("/auth/login", async (_request, reply) => {
		if (!oidc) {
			return fail(reply, 500, "INTERNAL", "Login is not configured");
		}
		const { url, state } = await oidc.buildLoginRedirect();
		reply.setCookie(loginCookie, JSON.stringify(state), {
			...loginCookieOptions(auth),
			signed: true,
		});
		return reply.redirect(url, 302);
	});

	app.get("/auth/callback", async (request, reply) => {
		if (!oidc) {
			return fail(reply, 500, "INTERNAL", "Login is not configured");
		}

		const raw = request.cookies[loginCookie];
		const unsigned = raw ? request.unsignCookie(raw) : null;
		if (!unsigned?.valid || !unsigned.value) {
			return fail(
				reply,
				400,
				"VALIDATION_FAILED",
				"The login request expired. Please sign in again.",
			);
		}

		let loginState: LoginState;
		try {
			loginState = JSON.parse(unsigned.value) as LoginState;
		} catch {
			return fail(
				reply,
				400,
				"VALIDATION_FAILED",
				"The login request expired. Please sign in again.",
			);
		}

		reply.clearCookie(loginCookie, loginCookieOptions(auth));

		const callbackUrl = new URL(request.url, auth.publicUrl);

		let identity: Awaited<ReturnType<typeof oidc.completeLogin>>["identity"];
		let claims: Record<string, unknown>;
		try {
			const completed = await oidc.completeLogin(callbackUrl, loginState);
			identity = completed.identity;
			claims = completed.claims as Record<string, unknown>;
		} catch (error) {
			if (error instanceof OidcError) {
				await audit(request, "auth.login", "unknown", "unknown", "failed");
				return fail(reply, 401, "UNAUTHORIZED", "Sign-in failed. Please try again.");
			}
			throw error;
		}

		const role = mapRole(claims, auth);
		if (!role) {
			// Prefix the subject so a crafted one cannot look like `user:<uuid>`.
			await audit(
				request,
				"auth.login",
				`subject:${identity.subject}`,
				identity.subject,
				"denied",
			);
			return fail(reply, 403, "FORBIDDEN", DENIED_MESSAGE);
		}

		const user = await upsertUser(db, identity, role);

		if (user.disabledAt) {
			await audit(request, "auth.login", `user:${user.id}`, user.id, "denied");
			return fail(reply, 403, "FORBIDDEN", DENIED_MESSAGE);
		}

		const session = await createSession(db, user.id, auth.sessionTtlSeconds);
		reply.setCookie(sessionCookie, session.token, {
			...sessionCookieOptions(auth),
			expires: session.expiresAt,
		});

		await audit(request, "auth.login", `user:${user.id}`, user.id, "ok");
		return reply.redirect("/", 302);
	});

	app.post("/auth/logout", async (request, reply) => {
		const user = request.user;
		if (request.sessionToken) {
			// A preview session lives with the main one, so signing out ends it
			// too (BROWSER-HANDLING.md §9.2). The row would go with the cascade
			// below anyway; revoking first makes the intent explicit and leaves
			// no window where the preview still authorizes.
			await revokeSessionPreviewSessions(db, request.sessionToken);
			await deleteSession(db, request.sessionToken);
		}
		if (user) {
			await audit(request, "auth.logout", `user:${user.id}`, user.id, "ok");
		}
		reply.clearCookie(sessionCookie, sessionCookieOptions(auth));
		return reply.redirect("/", 303);
	});

	app.get("/auth/me", async (request, reply) => {
		if (!request.user) {
			return fail(reply, 401, "UNAUTHORIZED", "Sign in to continue");
		}
		// The session user has no sign-in name; it lives on the user row.
		const row = await db
			.selectFrom("users")
			.select("oidc_subject")
			.where("id", "=", request.user.id)
			.executeTakeFirst();
		if (!row) {
			return fail(reply, 401, "UNAUTHORIZED", "Sign in to continue");
		}
		const body: MeResponse = { ...request.user, oidcSubject: row.oidc_subject };
		return reply.send(body);
	});
}
