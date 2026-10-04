import { createHmac, timingSafeEqual } from "node:crypto";
import { DEX_PASSWORD_ROUTE } from "@portikus/auth";
import type { ApiConfig } from "@portikus/config";
import { type Database, recordAudit } from "@portikus/db";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Kysely } from "kysely";
import { fromLoopback } from "./loopback.js";
import { accountKey, type SigninThrottle } from "./signin-throttle.js";

/**
 * Dex's password form posts come here from Caddy instead of going straight
 * to Dex, so the API can count them per address and per account and audit
 * every wrong password (SPEC.md section 24.13). The post is passed on to
 * Dex unchanged and Dex's answer goes back to the browser unchanged.
 */

const KNOWN_DEVICE_COOKIE = "portikus_known_device";
const KNOWN_DEVICE_MAX_AGE_SECONDS = 180 * 24 * 60 * 60;
/** Audit targets keep a login this long at most; the form takes any text. */
const MAX_LOGIN_LENGTH = 254;
const FORWARDED_REQUEST_HEADERS = ["accept", "accept-language", "cookie", "user-agent"];
/** fetch has already decoded and measured the body. */
const DROPPED_RESPONSE_HEADERS = new Set([
	"connection",
	"content-encoding",
	"content-length",
	"keep-alive",
	"set-cookie",
	"transfer-encoding",
]);

export type DexOutcome = "success" | "failure" | "other";

/**
 * Dex redirects once the password is right and renders the form again,
 * with an error, when it is wrong.
 */
export function dexOutcome(status: number): DexOutcome {
	if (status >= 300 && status < 400) return "success";
	if (status === 200 || status === 401) return "failure";
	return "other";
}

function cookieName(config: ApiConfig): string {
	return config.PUBLIC_URL.startsWith("https:")
		? `__Host-${KNOWN_DEVICE_COOKIE}`
		: KNOWN_DEVICE_COOKIE;
}

/** The cookie value that marks a browser as one this account signed in on. */
function knownDeviceValue(secret: string, login: string): string {
	return createHmac("sha256", secret)
		.update(`known-device\0${accountKey(login)}`)
		.digest("base64url");
}

function isKnownDevice(
	request: FastifyRequest,
	config: ApiConfig,
	login: string,
): boolean {
	const sent = request.cookies[cookieName(config)];
	if (!sent) return false;
	const expected = Buffer.from(knownDeviceValue(config.SESSION_COOKIE_SECRET, login));
	const actual = Buffer.from(sent);
	return actual.length === expected.length && timingSafeEqual(actual, expected);
}

const REFUSAL_PAGE = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Too many sign-in attempts</title></head>
<body>
<main>
<h1>Too many sign-in attempts</h1>
<p>There have been too many wrong passwords for this sign-in. Wait ten minutes, then try again.</p>
<p>If you have signed in on this browser before, you can still sign in here with the right password.</p>
</main>
</body>
</html>
`;

const UNAVAILABLE_PAGE = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Sign-in unavailable</title></head>
<body><main><h1>Sign-in is unavailable</h1><p>Try again in a minute.</p></main></body>
</html>
`;

export function registerDexPasswordRelay(
	app: FastifyInstance,
	deps: { db: Kysely<Database>; config: ApiConfig; throttle: SigninThrottle },
): void {
	const { db, config, throttle } = deps;
	const dexUrl = config.DEX_HTTP_URL;

	async function audit(
		request: FastifyRequest,
		action: string,
		target: string,
		metadata: Record<string, unknown>,
	) {
		try {
			await recordAudit(db, {
				actor: "unknown",
				target,
				action,
				result: action === "auth.throttled" ? "denied" : "failed",
				metadata: { ip: request.ip, ...metadata },
			});
		} catch (error) {
			request.log.error({ err: error }, "could not audit a password sign-in");
		}
	}

	async function refuse(reply: FastifyReply): Promise<FastifyReply> {
		return reply
			.status(429)
			.header("content-type", "text/html; charset=utf-8")
			.header("retry-after", "600")
			.send(REFUSAL_PAGE);
	}

	/**
	 * Refuse when this address or account is over its limit. A browser this
	 * account signed in on is not refused for wrong passwords others typed
	 * for the account (SPEC.md section 24.13).
	 */
	async function refused(
		request: FastifyRequest,
		login: string,
		target: string,
	): Promise<boolean> {
		const byAddress = throttle.checkPassword(request.ip);
		if (!byAddress.allowed) {
			if (byAddress.audit) {
				await audit(request, "auth.throttled", target, { scope: "password" });
			}
			return true;
		}
		if (isKnownDevice(request, config, login)) return false;
		const byAccount = throttle.checkAccount(login);
		if (byAccount.allowed) return false;
		if (byAccount.audit) {
			await audit(request, "auth.throttled", target, { scope: "password-account" });
		}
		return true;
	}

	function sendToDex(
		request: FastifyRequest,
		fields: Record<string, unknown>,
		dexUrl: string,
	): Promise<Response> {
		const headers: Record<string, string> = {
			"content-type": "application/x-www-form-urlencoded",
		};
		for (const name of FORWARDED_REQUEST_HEADERS) {
			const value = request.headers[name];
			if (typeof value === "string") headers[name] = value;
		}
		const form = new URLSearchParams();
		for (const [key, value] of Object.entries(fields)) {
			if (typeof value === "string") form.append(key, value);
		}
		return fetch(new URL(request.raw.url ?? "/", dexUrl), {
			method: "POST",
			headers,
			body: form.toString(),
			redirect: "manual",
		});
	}

	async function passBack(
		reply: FastifyReply,
		answer: Response,
		knownLogin: string | null,
	): Promise<FastifyReply> {
		reply.status(answer.status);
		answer.headers.forEach((value, name) => {
			if (!DROPPED_RESPONSE_HEADERS.has(name)) reply.header(name, value);
		});
		// The cookie plugin adds ours to Dex's own when the reply is sent.
		const dexCookies = answer.headers.getSetCookie();
		if (dexCookies.length > 0) reply.header("set-cookie", dexCookies);
		if (knownLogin !== null) {
			reply.setCookie(
				cookieName(config),
				knownDeviceValue(config.SESSION_COOKIE_SECRET, knownLogin),
				{
					httpOnly: true,
					secure: config.PUBLIC_URL.startsWith("https:"),
					sameSite: "lax",
					path: "/",
					maxAge: KNOWN_DEVICE_MAX_AGE_SECONDS,
				},
			);
		}
		return reply.send(Buffer.from(await answer.arrayBuffer()));
	}

	app.post(DEX_PASSWORD_ROUTE, async (request, reply) => {
		// Only Caddy on this machine sends these; it is the front door's rate limit.
		if (!fromLoopback(request) || !dexUrl) {
			return reply.status(404).send({ code: "NOT_FOUND", message: "Not found." });
		}
		const fields = (request.body ?? {}) as Record<string, unknown>;
		const login =
			typeof fields.login === "string" ? fields.login.slice(0, MAX_LOGIN_LENGTH) : "";
		const target = login === "" ? "unknown" : `login:${accountKey(login)}`;
		if (await refused(request, login, target)) return refuse(reply);

		let answer: Response;
		try {
			answer = await sendToDex(request, fields, dexUrl);
		} catch (error) {
			request.log.error({ err: error }, "dex did not answer a password post");
			return reply
				.status(502)
				.header("content-type", "text/html; charset=utf-8")
				.send(UNAVAILABLE_PAGE);
		}

		const outcome = dexOutcome(answer.status);
		if (outcome === "failure") {
			throttle.accountFailed(login);
			await audit(request, "auth.password_failed", target, {});
		}
		return passBack(
			reply,
			answer,
			outcome === "success" && login !== "" ? login : null,
		);
	});
}
