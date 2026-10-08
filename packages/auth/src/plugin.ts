import type { IncomingHttpHeaders } from "node:http";
import cookie, { type CookieSerializeOptions } from "@fastify/cookie";
import type { Database } from "@portikus/db";
import type { FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from "fastify";
import fp from "fastify-plugin";
import type { Kysely } from "kysely";
import { loadSession } from "./sessions.js";
import type { AuthOptions, AuthUser, Role } from "./types.js";
import { CONNECTOR_COOKIE, LOGIN_COOKIE, SESSION_COOKIE } from "./types.js";

declare module "fastify" {
	interface FastifyRequest {
		user: AuthUser | null;
		sessionToken: string | null;
	}
}

const STATE_CHANGING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** The route the API relays Dex's password form posts on (SPEC.md section 24.13). */
export const DEX_PASSWORD_ROUTE = "/dex/auth/*";

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

export function connectorCookieName(auth: AuthOptions): string {
	return isSecure(auth) ? `__Host-${CONNECTOR_COOKIE}` : CONNECTOR_COOKIE;
}

/** It names a connector, nothing secret, and outlives sign-out on purpose. */
export function connectorCookieOptions(auth: AuthOptions): CookieSerializeOptions {
	return {
		httpOnly: true,
		sameSite: "lax",
		path: "/",
		secure: isSecure(auth),
		signed: true,
		maxAge: 90 * 24 * 3600,
	};
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
 * signature, state and nonce protect them instead (ADR 0025).
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
	// Dex's password form, relayed by the API, is how a session starts.
	if (request.method === "POST" && url === DEX_PASSWORD_ROUTE) return true;
	// The preview host never carries the main session cookie, and the edge
	// authorization subrequest carries none at all: both authenticate with the
	// preview session instead (BROWSER-HANDLING.md §9.2, §10).
	if (request.method === "GET" && url.startsWith("/__portikus/")) return true;
	return request.method === "GET" && url === "/preview/authorize";
}

type GateCode =
	| "SECOND_FACTOR_REQUIRED"
	| "PASSWORD_CHANGE_REQUIRED"
	| "ACCEPTABLE_USE_REQUIRED";

type GatedUser = Pick<
	AuthUser,
	"mustChangePassword" | "mustAcceptUse" | "secondFactor"
>;

interface Gate {
	code: GateCode;
	message: string;
	holds: (user: GatedUser) => boolean;
	/** Routes this gate allows beyond the exempt ones, as "METHOD url". */
	allows: string[];
}

/** The second-factor routes, open while either second-factor gate holds. */
const SECOND_FACTOR_ROUTES = [
	"GET /me/second-factor",
	"POST /me/second-factor/totp/start",
	"POST /me/second-factor/totp",
	"POST /me/second-factor/verify",
	"POST /me/second-factor/webauthn/start",
	"POST /me/second-factor/webauthn",
	"POST /me/second-factor/webauthn/verify/start",
	"POST /me/second-factor/webauthn/verify",
];

/**
 * The ordered gates a signed-in account passes before anything else
 * (SPEC.md sections 5.1, 5.3 and 24.13). The first unmet one wins. An
 * enrolled account proves its second factor before anything else, even a
 * password change, so a stolen password alone changes nothing; an account
 * with no factor yet enrols after choosing its own password.
 */
const GATES: Gate[] = [
	{
		code: "SECOND_FACTOR_REQUIRED",
		message: "Enter a code from your authenticator app to continue.",
		holds: (user) => user.secondFactor === "verify",
		allows: SECOND_FACTOR_ROUTES,
	},
	{
		code: "PASSWORD_CHANGE_REQUIRED",
		message: "Choose a new password to continue.",
		holds: (user) => user.mustChangePassword === true,
		allows: ["POST /me/password"],
	},
	{
		code: "SECOND_FACTOR_REQUIRED",
		message: "Set up two-step sign-in to continue.",
		holds: (user) => user.secondFactor === "enrol",
		allows: SECOND_FACTOR_ROUTES,
	},
	{
		code: "ACCEPTABLE_USE_REQUIRED",
		message: "Accept the acceptable-use statement to continue.",
		holds: (user) => user.mustAcceptUse === true,
		allows: ["GET /me/acceptable-use", "POST /me/acceptable-use"],
	},
];

function firstGate(user: GatedUser): Gate | undefined {
	return GATES.find((gate) => gate.holds(user));
}

/** What a signed-in account may still reach while this gate holds it. */
function passesGate(request: FastifyRequest, gate: Gate): boolean {
	if (isExempt(request)) return true;
	return gate.allows.includes(`${request.method} ${request.routeOptions.url}`);
}

/**
 * The first gate holding this account, or null when it may use everything.
 * The one place the gates are decided; the preview gateway asks it too.
 */
export function sessionGate(
	user: GatedUser,
): { code: GateCode; message: string } | null {
	const gate = firstGate(user);
	return gate ? { code: gate.code, message: gate.message } : null;
}

export interface AuthPluginOptions {
	db: Kysely<Database>;
	auth: AuthOptions;
	/**
	 * Called when a session cookie matches no session. Answering and
	 * returning false ends the request.
	 */
	unknownSession?: (request: FastifyRequest, reply: FastifyReply) => Promise<boolean>;
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
					if (opts.unknownSession && !(await opts.unknownSession(request, reply))) {
						return;
					}
					reply.clearCookie(sessionCookie, { path: "/" });
				}
			}

			if (!request.user && !isExempt(request)) {
				await reply
					.code(401)
					.send({ code: "UNAUTHORIZED", message: "authentication required" });
				return;
			}

			// A WebSocket upgrade is never on the allowed list, so it is refused too.
			const gate = request.user ? firstGate(request.user) : undefined;
			if (gate && !passesGate(request, gate)) {
				await reply.code(403).send({ code: gate.code, message: gate.message });
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
