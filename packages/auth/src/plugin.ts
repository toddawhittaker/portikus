import type { IncomingHttpHeaders } from "node:http";
import cookie, { type CookieSerializeOptions } from "@fastify/cookie";
import type { Database } from "@portikus/db";
import type { FastifyRequest, preHandlerAsyncHookHandler } from "fastify";
import fp from "fastify-plugin";
import type { Kysely } from "kysely";
import { loadSession } from "./sessions.js";
import type { AuthOptions, AuthUser, Role } from "./types.js";
import { LOGIN_COOKIE, SESSION_COOKIE } from "./types.js";

declare module "fastify" {
	interface FastifyRequest {
		user: AuthUser | null;
		sessionToken: string | null;
	}
}

const STATE_CHANGING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function headerValue(headers: IncomingHttpHeaders, name: string): string | null {
	const value = headers[name];
	if (typeof value === "string") {
		return value;
	}
	return Array.isArray(value) && value[0] !== undefined ? value[0] : null;
}

/**
 * CSRF defence for state-changing requests (SPEC.md section 5.3): a
 * same-origin fetch metadata header, or failing that an Origin header
 * that matches the site's own origin.
 */
export function checkCsrf(headers: IncomingHttpHeaders, publicOrigin: string): boolean {
	const site = headerValue(headers, "sec-fetch-site");
	if (site !== null) {
		// Explicit cross-site metadata always loses; Origin is only a fallback.
		return site === "same-origin" || site === "none";
	}
	return headerValue(headers, "origin") === publicOrigin;
}

/** WebSocket upgrades always need an Origin from our own site. */
export function checkWsOrigin(
	headers: IncomingHttpHeaders,
	publicOrigin: string,
): boolean {
	return headerValue(headers, "origin") === publicOrigin;
}

function isSecure(auth: AuthOptions): boolean {
	return auth.publicUrl.startsWith("https:");
}

/**
 * Over https the cookies carry the `__Host-` prefix, which browsers only
 * accept when the cookie is Secure, Path=/ and has no Domain, so no other
 * host on the site can overwrite them (SPEC.md section 5.3).
 */
export function sessionCookieName(auth: AuthOptions): string {
	return isSecure(auth) ? `__Host-${SESSION_COOKIE}` : SESSION_COOKIE;
}

export function loginCookieName(auth: AuthOptions): string {
	return isSecure(auth) ? `__Host-${LOGIN_COOKIE}` : LOGIN_COOKIE;
}

export function sessionCookieOptions(auth: AuthOptions): CookieSerializeOptions {
	return {
		httpOnly: true,
		sameSite: "lax",
		path: "/",
		secure: isSecure(auth),
		maxAge: auth.sessionTtlSeconds,
	};
}

/** The short-lived cookie that carries the PKCE verifier, state, and nonce. */
export function loginCookieOptions(auth: AuthOptions): CookieSerializeOptions {
	return {
		httpOnly: true,
		sameSite: "lax",
		path: "/",
		secure: isSecure(auth),
		signed: true,
		maxAge: 600,
	};
}

/**
 * The two cross-site POSTs an LMS makes during an LTI launch. The id_token
 * signature, state and nonce protect them instead (docs/archive/epics/EPIC-13.md ruling 7).
 */
function isCsrfExempt(request: FastifyRequest): boolean {
	const url = request.routeOptions.url;
	return request.method === "POST" && (url === "/lti/login" || url === "/lti/launch");
}

function isExempt(request: FastifyRequest): boolean {
	// Match the routed URL, not the raw one, so query strings or path
	// tricks cannot widen the exemption.
	const url = request.routeOptions.url;
	if (!url) {
		return false;
	}
	if (request.method === "GET" && url === "/health") return true;
	if (url.startsWith("/auth/")) return true;
	// An LTI launch is how an LMS user gets a session in the first place.
	if (url === "/lti/login" || url === "/lti/launch" || url === "/lti/jwks") return true;
	// A new standalone Dex site has nobody to sign in as (docs/archive/epics/EPIC-14.md ruling 18).
	if (request.method === "GET" && url === "/setup/state") return true;
	if (request.method === "POST" && url === "/setup/first-account") return true;
	// The preview host never carries the main session cookie, and the edge
	// authorization subrequest carries none at all: both authenticate with the
	// preview session instead (BROWSER-HANDLING.md §9.2, §10).
	if (request.method === "GET" && url.startsWith("/__portikus/")) return true;
	return request.method === "GET" && url === "/preview/authorize";
}

export interface AuthPluginOptions {
	db: Kysely<Database>;
	auth: AuthOptions;
}

/**
 * Identity for every request: WebSocket origin check, CSRF check, session
 * lookup, then deny by default unless the route is exempt.
 */
export const authPlugin = fp<AuthPluginOptions>(
	async (app, opts) => {
		const { db, auth } = opts;
		const publicOrigin = new URL(auth.publicUrl).origin;
		const sessionCookie = sessionCookieName(auth);

		await app.register(cookie, { secret: auth.cookieSecret });

		app.decorateRequest("user", null);
		app.decorateRequest("sessionToken", null);

		app.addHook("onRequest", async (request, reply) => {
			const isUpgrade =
				headerValue(request.headers, "upgrade")?.toLowerCase() === "websocket";

			if (isUpgrade) {
				if (!checkWsOrigin(request.headers, publicOrigin)) {
					await reply
						.code(403)
						.send({ code: "FORBIDDEN", message: "origin not allowed" });
					return;
				}
			} else if (STATE_CHANGING.has(request.method) && !isCsrfExempt(request)) {
				if (!checkCsrf(request.headers, publicOrigin)) {
					await reply
						.code(403)
						.send({ code: "FORBIDDEN", message: "origin not allowed" });
					return;
				}
			}

			const token = request.cookies[sessionCookie];
			if (token) {
				const user = await loadSession(db, token);
				if (user) {
					request.user = user;
					request.sessionToken = token;
				} else {
					reply.clearCookie(sessionCookie, { path: "/" });
				}
			}

			if (!request.user && !isExempt(request)) {
				await reply
					.code(401)
					.send({ code: "UNAUTHORIZED", message: "authentication required" });
			}
		});
	},
	{ name: "portikus-auth", fastify: "5.x" },
);

/**
 * The user the auth plugin already resolved. The plugin answers 401 before
 * a protected handler runs, so the null branch should be unreachable.
 */
export function requireUser(request: FastifyRequest): AuthUser {
	if (!request.user) {
		throw new Error("route reached without an authenticated user");
	}
	return request.user;
}

export function requireRole(role: Role): preHandlerAsyncHookHandler {
	return async function checkRole(request, reply) {
		if (request.user?.role !== role) {
			await reply.code(403).send({ code: "FORBIDDEN", message: "insufficient role" });
		}
	};
}
