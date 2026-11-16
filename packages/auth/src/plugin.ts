import type { IncomingHttpHeaders } from "node:http";
import cookie, { type CookieSerializeOptions } from "@fastify/cookie";
import { type AuditArrival, auditArrival, type Database } from "@portikus/db";
import type { FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from "fastify";
import fp from "fastify-plugin";
import type { Kysely } from "kysely";
import { type ApiKeyIdentity, bearerApiKey, resolveApiKey } from "./api-keys.js";
import { loadSession } from "./sessions.js";
import type { AuthOptions, AuthUser, Role } from "./types.js";
import { CONNECTOR_COOKIE, LOGIN_COOKIE, SESSION_COOKIE } from "./types.js";

declare module "fastify" {
	interface FastifyRequest {
		user: AuthUser | null;
		sessionToken: string | null;
		/** The key that signed this request in; null for a session (SPEC.md section 24.13). */
		apiKey: ApiKeyIdentity | null;
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
	// The Deep Linking picker's submit: its single-use handle authorizes it,
	// and the instructor never gets a session (ADR 0058).
	if (request.method === "POST" && url === "/lti/deep-link") return true;
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

/** A WebSocket upgrade must come from our origin, and so must a state-changing request that is not exempt. */
function originAllowed(request: FastifyRequest, publicOrigin: string): boolean {
	const isUpgrade =
		headerValue(request.headers, "upgrade")?.toLowerCase() === "websocket";
	if (isUpgrade) return checkWsOrigin(request.headers, publicOrigin);
	if (STATE_CHANGING.has(request.method) && !isCsrfExempt(request)) {
		return checkCsrf(request.headers, publicOrigin);
	}
	return true;
}

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

/** What the API supplies to let API-key requests through (SPEC.md section 24.13). */
export interface ApiKeyHooks {
	/**
	 * Called with each resolved key request; answering and returning false
	 * ends it. The scope gate and the per-key limit live here.
	 */
	authorize: (request: FastifyRequest, reply: FastifyReply) => Promise<boolean>;
	/** Like `beforeLookup` for a session cookie, for a key before it is looked up. */
	beforeLookup?: (
		request: FastifyRequest,
		reply: FastifyReply,
		secret: string,
	) => Promise<boolean>;
	/** Like `unknownSession`: called when a key is no good, before the 401. */
	unknownKey?: (
		request: FastifyRequest,
		reply: FastifyReply,
		secret: string,
	) => Promise<boolean>;
}

export interface AuthPluginOptions {
	db: Kysely<Database>;
	auth: AuthOptions;
	/**
	 * Called with a session cookie before it is looked up. Answering and
	 * returning false ends the request without a query.
	 */
	beforeLookup?: (
		request: FastifyRequest,
		reply: FastifyReply,
		token: string,
	) => Promise<boolean>;
	/**
	 * Called when a session cookie matches no session. Answering and
	 * returning false ends the request.
	 */
	unknownSession?: (
		request: FastifyRequest,
		reply: FastifyReply,
		token: string,
	) => Promise<boolean>;
	/**
	 * Lets requests with `Authorization: Bearer portikus_...` in. Without it
	 * every such request is refused, so a missing gate fails closed.
	 */
	apiKeys?: ApiKeyHooks;
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
		app.decorateRequest("apiKey", null);

		// Every audit row written while serving the request records how it arrived.
		// Callback style, so the store covers the later hooks and the handler.
		app.addHook("onRequest", (request, _reply, done) => {
			const arrival: AuditArrival = {
				via:
					bearerApiKey(request.headers.authorization) === null ? "session" : "api_key",
				apiKeyId: null,
			};
			auditArrival.run(arrival, done);
		});

		/** Set the request's user from its cookie; false when the request was answered. */
		async function resolveSession(
			request: FastifyRequest,
			reply: FastifyReply,
			token: string,
		): Promise<boolean> {
			if (opts.beforeLookup && !(await opts.beforeLookup(request, reply, token))) {
				return false;
			}
			const user = await loadSession(db, token);
			if (user) {
				request.user = user;
				request.sessionToken = token;
				return true;
			}
			if (opts.unknownSession && !(await opts.unknownSession(request, reply, token))) {
				return false;
			}
			reply.clearCookie(sessionCookie, { path: "/" });
			return true;
		}

		/** Set the request's user from its API key; false when the request was answered. */
		async function resolveKey(
			request: FastifyRequest,
			reply: FastifyReply,
			secret: string,
		): Promise<boolean> {
			const hooks = opts.apiKeys;
			if (!hooks) {
				await reply.code(403).send({
					code: "NOT_AVAILABLE_TO_API_KEYS",
					message: "API keys are not accepted here",
				});
				return false;
			}
			// A key never opens a WebSocket: that path starts from a browser's origin.
			if (headerValue(request.headers, "upgrade")?.toLowerCase() === "websocket") {
				await reply.code(403).send({
					code: "NOT_AVAILABLE_TO_API_KEYS",
					message: "API keys cannot open WebSocket connections",
				});
				return false;
			}
			if (hooks.beforeLookup && !(await hooks.beforeLookup(request, reply, secret))) {
				return false;
			}
			const resolved = await resolveApiKey(db, secret);
			if (!resolved) {
				if (hooks.unknownKey && !(await hooks.unknownKey(request, reply, secret))) {
					return false;
				}
				// One answer for unknown, revoked and expired, so a caller learns nothing about a key.
				await reply
					.code(401)
					.header("www-authenticate", "Bearer")
					.send({ code: "UNAUTHORIZED", message: "invalid API key" });
				return false;
			}
			request.user = resolved.user;
			request.apiKey = resolved.key;
			request.sessionToken = null;
			const arrival = auditArrival.getStore();
			if (arrival) arrival.apiKeyId = resolved.key.id;
			return hooks.authorize(request, reply);
		}

		app.addHook("onRequest", async (request, reply) => {
			const keySecret = bearerApiKey(request.headers.authorization);
			if (keySecret !== null) {
				// The cookie is ignored. No origin check: a browser cannot send this
				// header cross-site without a preflight the API never answers.
				if (!(await resolveKey(request, reply, keySecret))) return;
			} else {
				if (!originAllowed(request, publicOrigin)) {
					await reply
						.code(403)
						.send({ code: "FORBIDDEN", message: "origin not allowed" });
					return;
				}

				const token = request.cookies[sessionCookie];
				if (token && !(await resolveSession(request, reply, token))) return;
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
