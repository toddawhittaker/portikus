import {
	createSession,
	deleteSession,
	LOGIN_COOKIE,
	type LoginState,
	loginCookieOptions,
	mapRole,
	OidcError,
	SESSION_COOKIE,
	sessionCookieOptions,
	upsertUser,
} from "@portikus/auth";
import type { ApiError, MeResponse } from "@portikus/contracts";
import type { FastifyInstance, FastifyReply } from "fastify";
import { toAuthOptions } from "../auth-options.js";
import type { ServerDeps } from "../server.js";

const DENIED_MESSAGE = "Your account is not authorized to use Portikus";

/** Login, logout, and the current-user route (SPEC.md §5.1, §5.2, §5.3). */
export function registerAuthRoutes(
	app: FastifyInstance,
	{ db, config, oidc }: ServerDeps,
): void {
	const auth = toAuthOptions(config);

	async function audit(actor: string, target: string, result: string): Promise<void> {
		await db
			.insertInto("audit_events")
			.values({ actor, target, action: "auth.login", result })
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
		reply.setCookie(LOGIN_COOKIE, JSON.stringify(state), {
			...loginCookieOptions(auth),
			signed: true,
		});
		return reply.redirect(url, 302);
	});

	app.get("/auth/callback", async (request, reply) => {
		if (!oidc) {
			return fail(reply, 500, "INTERNAL", "Login is not configured");
		}

		const raw = request.cookies[LOGIN_COOKIE];
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

		reply.clearCookie(LOGIN_COOKIE, loginCookieOptions(auth));

		const callbackUrl = new URL(request.url, auth.publicUrl);

		let identity: Awaited<ReturnType<typeof oidc.completeLogin>>["identity"];
		let claims: Record<string, unknown>;
		try {
			const completed = await oidc.completeLogin(callbackUrl, loginState);
			identity = completed.identity;
			claims = completed.claims as Record<string, unknown>;
		} catch (error) {
			if (error instanceof OidcError) {
				await audit("unknown", "unknown", "failed");
				return fail(reply, 401, "UNAUTHORIZED", "Sign-in failed. Please try again.");
			}
			throw error;
		}

		const role = mapRole(claims, auth);
		if (!role) {
			await audit(identity.subject, identity.subject, "denied");
			return fail(reply, 403, "FORBIDDEN", DENIED_MESSAGE);
		}

		const user = await upsertUser(db, identity, role);

		const row = await db
			.selectFrom("users")
			.select("disabled_at")
			.where("id", "=", user.id)
			.executeTakeFirst();
		if (row?.disabled_at) {
			await audit(`user:${user.id}`, user.id, "denied");
			return fail(reply, 403, "FORBIDDEN", DENIED_MESSAGE);
		}

		const session = await createSession(db, user.id, auth.sessionTtlSeconds);
		reply.setCookie(SESSION_COOKIE, session.token, {
			...sessionCookieOptions(auth),
			expires: session.expiresAt,
		});

		await audit(`user:${user.id}`, user.id, "ok");
		return reply.redirect("/", 302);
	});

	app.post("/auth/logout", async (request, reply) => {
		if (request.sessionToken) {
			await deleteSession(db, request.sessionToken);
		}
		reply.clearCookie(SESSION_COOKIE, sessionCookieOptions(auth));
		return reply.redirect("/", 303);
	});

	app.get("/auth/me", async (request, reply) => {
		if (!request.user) {
			return fail(reply, 401, "UNAUTHORIZED", "Sign in to continue");
		}
		const body: MeResponse = request.user;
		return reply.send(body);
	});
}
