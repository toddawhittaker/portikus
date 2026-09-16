import type { IncomingHttpHeaders } from "node:http";
import cookie, { type CookieSerializeOptions } from "@fastify/cookie";
import type { Database } from "@portikus/db";
import type { FastifyRequest, preHandlerAsyncHookHandler } from "fastify";
import fp from "fastify-plugin";
import type { Kysely } from "kysely";
import { loadSession } from "./sessions.js";
import type { AuthOptions, AuthUser, Role } from "./types.js";
import { SESSION_COOKIE } from "./types.js";

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
	if (site === "same-origin" || site === "none") {
		return true;
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

export function sessionCookieOptions(auth: AuthOptions): CookieSerializeOptions {
	return {
		httpOnly: true,
		sameSite: "lax",
		path: "/",
		secure: auth.publicUrl.startsWith("https:"),
		maxAge: auth.sessionTtlSeconds,
	};
}

/** The short-lived cookie that carries the PKCE verifier, state, and nonce. */
export function loginCookieOptions(auth: AuthOptions): CookieSerializeOptions {
	return {
		httpOnly: true,
		sameSite: "lax",
		path: "/",
		secure: auth.publicUrl.startsWith("https:"),
		signed: true,
		maxAge: 600,
	};
}

function isExempt(request: FastifyRequest): boolean {
	// Match the routed URL, not the raw one, so query strings or path
	// tricks cannot widen the exemption.
	const url = request.routeOptions.url;
	if (!url) {
		return false;
	}
	return (request.method === "GET" && url === "/health") || url.startsWith("/auth/");
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
			} else if (STATE_CHANGING.has(request.method)) {
				if (!checkCsrf(request.headers, publicOrigin)) {
					await reply
						.code(403)
						.send({ code: "FORBIDDEN", message: "origin not allowed" });
					return;
				}
			}

			const token = request.cookies[SESSION_COOKIE];
			if (token) {
				const user = await loadSession(db, token);
				if (user) {
					request.user = user;
					request.sessionToken = token;
				} else {
					reply.clearCookie(SESSION_COOKIE, { path: "/" });
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

export function requireRole(role: Role): preHandlerAsyncHookHandler {
	return async function checkRole(request, reply) {
		if (request.user?.role !== role) {
			await reply.code(403).send({ code: "FORBIDDEN", message: "insufficient role" });
		}
	};
}
