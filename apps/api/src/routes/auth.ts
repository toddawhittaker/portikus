import {
	bindLinkIntent,
	deleteSession,
	findLinkIntent,
	hashSessionToken,
	type LinkIntent,
	type LoginState,
	loginCookieName,
	loginCookieOptions,
	mapRole,
	OidcError,
	platformIssuerOf,
	sessionCookieName,
	sessionCookieOptions,
} from "@portikus/auth";
import type { ApiError, LinkError, MeResponse } from "@portikus/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { toAuthOptions } from "../auth-options.js";
import { revokeSessionPreviewSessions } from "../preview/store.js";
import type { ServerDeps } from "../server.js";
import {
	completeSignIn,
	requestMetadata,
	audit as writeAudit,
} from "./start-session.js";

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
				metadata: JSON.stringify(requestMetadata(request)),
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
		let loginState: LoginState | null = null;
		if (unsigned?.valid && unsigned.value) {
			try {
				loginState = JSON.parse(unsigned.value) as LoginState;
			} catch {
				loginState = null;
			}
		}
		if (!loginState) {
			// A link attempt whose cookie is gone still belongs on the link page (ruling 18).
			const { state } = request.query as { state?: unknown };
			if (typeof state === "string" && (await findLinkIntent(db, state))) {
				return reply.redirect("/link?error=expired", 302);
			}
			return fail(
				reply,
				400,
				"VALIDATION_FAILED",
				"The login request expired. Please sign in again.",
			);
		}

		reply.clearCookie(loginCookie, loginCookieOptions(auth));

		const callbackUrl = new URL(request.url, auth.publicUrl);

		// A stored intent under this state means the course account asked to
		// link (docs/archive/epics/EPIC-13-1.md, "The flow" step 3); otherwise a sign-in.
		const intent = await findLinkIntent(db, loginState.state);
		if (intent) {
			return linkCallback(request, reply, callbackUrl, loginState, intent);
		}

		let completed: Awaited<ReturnType<typeof oidc.completeLogin>>;
		try {
			completed = await oidc.completeLogin(callbackUrl, loginState);
		} catch (error) {
			if (error instanceof OidcError) {
				await audit(request, "auth.login", "unknown", "unknown", "failed");
				return fail(reply, 401, "UNAUTHORIZED", "Sign-in failed. Please try again.");
			}
			throw error;
		}

		const { identity, claims } = completed;
		const role = mapRole(claims, auth);
		if (!role) {
			// Prefix the subject so a crafted one cannot look like `user:<uuid>`.
			await writeAudit(
				db,
				"auth.login",
				`subject:${identity.subject}`,
				identity.subject,
				"denied",
				requestMetadata(request),
			);
			return fail(reply, 403, "FORBIDDEN", DENIED_MESSAGE);
		}

		const signedIn = await completeSignIn(db, auth, reply, {
			identity,
			role,
			method: "oidc",
			loginMetadata: requestMetadata(request),
			roleChangeMetadata: { source: "oidc" },
		});
		if (!signedIn.ok) return fail(reply, 403, "FORBIDDEN", DENIED_MESSAGE);
		return reply.redirect("/", 302);
	});

	/**
	 * The callback in link mode (ruling 3 and 18): it never creates, updates
	 * or signs in a user. It only binds the SSO account to the intent, and
	 * every outcome goes to /link.
	 */
	async function linkCallback(
		request: FastifyRequest,
		reply: FastifyReply,
		callbackUrl: URL,
		loginState: LoginState,
		intent: LinkIntent,
	) {
		if (!oidc) return fail(reply, 500, "INTERNAL", "Login is not configured");
		const refuse = async (
			code: LinkError,
			result: "failed" | "denied",
			ssoUserId: string | null,
		) => {
			const who = ssoUserId ?? intent.courseUserId;
			await writeAudit(db, "user.linked", `user:${who}`, who, result, {
				reason: code,
				courseUserId: intent.courseUserId,
				...requestMetadata(request),
			});
			return reply.redirect(`/link?error=${code}`, 302);
		};

		const sessionId = request.sessionToken
			? hashSessionToken(request.sessionToken)
			: null;
		if (intent.sessionId !== sessionId)
			return refuse("session_changed", "failed", null);
		if (intent.userId !== null || intent.expiresAt <= new Date()) {
			return refuse("expired", "failed", null);
		}

		let completed: Awaited<ReturnType<typeof oidc.completeLogin>>;
		try {
			completed = await oidc.completeLogin(callbackUrl, loginState);
		} catch (error) {
			if (error instanceof OidcError) return refuse("failed", "failed", null);
			throw error;
		}
		if (!mapRole(completed.claims, auth)) {
			return refuse("not_authorized", "denied", null);
		}

		// Only the issuer and subject find the account, never email or username.
		const sso = await db
			.selectFrom("users")
			.select(["id", "disabled_at"])
			.where("oidc_issuer", "=", completed.identity.issuer)
			.where("oidc_subject", "=", completed.identity.subject)
			.executeTakeFirst();
		if (!sso) return refuse("no_account", "denied", null);
		if (sso.disabled_at !== null) return refuse("not_authorized", "denied", sso.id);

		const course = await db
			.selectFrom("users")
			.select("oidc_issuer")
			.where("id", "=", intent.courseUserId)
			.executeTakeFirstOrThrow();
		const platformIssuer = platformIssuerOf(course.oidc_issuer);
		const taken = await db
			.selectFrom("account_links")
			.select("course_user_id")
			.where("user_id", "=", sso.id)
			.where("platform_issuer", "=", platformIssuer)
			.executeTakeFirst();
		if (taken) return refuse("already_linked", "denied", sso.id);

		const bound = await bindLinkIntent(db, {
			state: loginState.state,
			sessionId: intent.sessionId,
			userId: sso.id,
		});
		if (bound) return refuse(bound, "failed", sso.id);
		return reply.redirect("/link", 302);
	}

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
			.select(["oidc_subject", "preferred_username"])
			.where("id", "=", request.user.id)
			.executeTakeFirst();
		if (!row) {
			return fail(reply, 401, "UNAUTHORIZED", "Sign in to continue");
		}
		// A Dex subject is an opaque blob, so prefer the username.
		const signInName = row.preferred_username || row.oidc_subject;
		const body: MeResponse = { ...request.user, signInName };
		return reply.send(body);
	});
}
