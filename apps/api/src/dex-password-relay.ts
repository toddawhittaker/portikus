import { createHmac, timingSafeEqual } from "node:crypto";
import { DEX_PASSWORD_ROUTE } from "@portikus/auth";
import type { ApiConfig } from "@portikus/config";
import { type Database, recordAudit } from "@portikus/db";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { type Kysely, sql } from "kysely";
import { fromLoopback } from "./loopback.js";
import { accountKey, type SigninThrottle } from "./signin-throttle.js";

/**
 * Dex's password form posts come here from Caddy instead of going straight
 * to Dex, so the API can count them per address and per account and audit
 * every wrong password (SPEC.md section 24.13). The post is passed on to
 * Dex unchanged and Dex's answer goes back to the browser unchanged.
 */

const KNOWN_DEVICE_COOKIE = "portikus_known_device";
const KNOWN_DEVICE_MAX_AGE_DAYS = 90;
const KNOWN_DEVICE_MAX_AGE_SECONDS = KNOWN_DEVICE_MAX_AGE_DAYS * 24 * 60 * 60;
const DAY_MS = 86_400_000;
/**
 * Dex local logins are emails or usernames. Anything else is refused, because
 * Go and JavaScript lower-case some letters differently and one account would
 * be counted under several keys (SPEC.md section 24.13).
 */
const PLAIN_ASCII = /^[\x20-\x7e]+$/;
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

/**
 * The newest password change or reset for this login, so a reset ends every
 * known-device cookie issued before it. The audit trail already records
 * both, which spares a column (SPEC.md section 24.13).
 */
async function passwordStamp(
	db: Kysely<Database>,
	issuer: string,
	login: string,
): Promise<string> {
	const row = await db
		.selectFrom("audit_events")
		// Audit targets are text; user IDs are UUIDs.
		.innerJoin("users", (join) =>
			join.on(sql<boolean>`audit_events.target = users.id::text`),
		)
		.select("audit_events.id")
		.where("users.oidc_issuer", "=", issuer)
		.where(sql<string>`lower(users.email)`, "=", accountKey(login))
		.where("audit_events.result", "=", "ok")
		.where("audit_events.action", "in", [
			"user.password_changed",
			"dex_user.password_reset",
			"local_admin.reset",
		])
		.orderBy("audit_events.id", "desc")
		.limit(1)
		.executeTakeFirst();
	return row ? String(row.id) : "none";
}

function today(): number {
	return Math.floor(Date.now() / DAY_MS);
}

/**
 * The cookie value that marks a browser as one this account signed in on. It
 * carries its issue day, signed with the rest, so the server ends a copied
 * value after ninety days whatever the browser does with Max-Age.
 */
function knownDeviceValue(
	secret: string,
	login: string,
	stamp: string,
	day: number,
): string {
	const mac = createHmac("sha256", secret)
		.update(`known-device\0${accountKey(login)}\0${stamp}\0${day}`)
		.digest("base64url");
	return `${day}.${mac}`;
}

function isKnownDevice(
	request: FastifyRequest,
	config: ApiConfig,
	login: string,
	stamp: string,
): boolean {
	const sent = request.cookies[cookieName(config)];
	if (!sent) return false;
	const dayText = sent.split(".")[0] ?? "";
	if (!/^\d{1,9}$/.test(dayText)) return false;
	const day = Number(dayText);
	const age = today() - day;
	if (age < 0 || age >= KNOWN_DEVICE_MAX_AGE_DAYS) return false;
	const expected = Buffer.from(
		knownDeviceValue(config.SESSION_COOKIE_SECRET, login, stamp, day),
	);
	const actual = Buffer.from(sent);
	return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Readable in light and dark, and usable on a phone (SPEC.md section 25.8). */
function page(title: string, body: string): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${title}</title>
<style>
body { font-family: system-ui, sans-serif; margin: 2rem auto; max-width: 36rem; padding: 0 1rem; line-height: 1.5; background: #ffffff; color: #1a1a1a; }
a { color: #0b57d0; }
@media (prefers-color-scheme: dark) {
body { background: #121212; color: #ececec; }
a { color: #8ab4f8; }
}
</style>
</head>
<body>
<main>
<h1>${title}</h1>
${body}
<p><a href="/auth/login">Back to sign in</a></p>
</main>
</body>
</html>
`;
}

const REFUSAL_PAGE = page(
	"Too many sign-in attempts",
	`<p>There have been too many wrong passwords for this sign-in. Wait ten minutes, then try again.</p>
<p>If you have signed in on this browser before, you can still sign in here with the right password.</p>`,
);

const UNAVAILABLE_PAGE = page(
	"Sign-in is unavailable",
	"<p>Try again in a minute.</p>",
);

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
	 * Count this post against its address and, unless the browser is one
	 * this account signed in on, its account, before Dex sees it, so parallel
	 * posts cannot slip past either limit (SPEC.md section 24.13). True when
	 * refused.
	 */
	async function refused(
		request: FastifyRequest,
		login: string,
		target: string,
		knownDevice: boolean,
	): Promise<boolean> {
		const byAddress = throttle.passwordAttempt(request.ip);
		if (!byAddress.allowed) {
			if (byAddress.audit) {
				await audit(request, "auth.throttled", target, { scope: "password" });
			}
			return true;
		}
		if (knownDevice) return false;
		const byAccount = throttle.accountAttempt(login);
		if (byAccount.allowed) return false;
		throttle.passwordGiveBack(request.ip);
		if (byAccount.audit) {
			await audit(request, "auth.throttled", target, { scope: "password-account" });
		}
		return true;
	}

	function sendToDex(
		request: FastifyRequest,
		form: URLSearchParams,
		dexUrl: string,
	): Promise<Response> {
		const headers: Record<string, string> = {
			"content-type": "application/x-www-form-urlencoded",
		};
		for (const name of FORWARDED_REQUEST_HEADERS) {
			const value = request.headers[name];
			if (typeof value === "string") headers[name] = value;
		}
		// Dex also reads login from the query, which would dodge the count.
		const url = new URL(request.raw.url ?? "/", dexUrl);
		url.searchParams.delete("login");
		return fetch(url, {
			method: "POST",
			headers,
			body: form.toString(),
			redirect: "manual",
		});
	}

	async function passBack(
		reply: FastifyReply,
		answer: Response,
		known: { login: string; stamp: string } | null,
	): Promise<FastifyReply> {
		reply.status(answer.status);
		answer.headers.forEach((value, name) => {
			if (!DROPPED_RESPONSE_HEADERS.has(name)) reply.header(name, value);
		});
		// The cookie plugin adds ours to Dex's own when the reply is sent.
		const dexCookies = answer.headers.getSetCookie();
		if (dexCookies.length > 0) reply.header("set-cookie", dexCookies);
		if (known !== null) {
			reply.setCookie(
				cookieName(config),
				knownDeviceValue(
					config.SESSION_COOKIE_SECRET,
					known.login,
					known.stamp,
					today(),
				),
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

	// Its own form parser keeps repeated fields, which the app-wide one
	// collapses, so a repeated login can be refused.
	app.register(async (scope) => {
		scope.removeContentTypeParser("application/x-www-form-urlencoded");
		scope.addContentTypeParser(
			"application/x-www-form-urlencoded",
			{ parseAs: "string" },
			(_request, body, done) => done(null, new URLSearchParams(body as string)),
		);
		scope.post(DEX_PASSWORD_ROUTE, relay);
	});

	async function relay(request: FastifyRequest, reply: FastifyReply) {
		// Only Caddy on this machine sends these; it is the front door's rate limit.
		if (!fromLoopback(request) || !dexUrl) {
			return reply.status(404).send({ code: "NOT_FOUND", message: "Not found." });
		}
		const form =
			request.body instanceof URLSearchParams ? request.body : new URLSearchParams();
		// A missing, empty or repeated login would be counted under no account.
		const logins = form.getAll("login");
		const first = logins[0] ?? "";
		if (logins.length !== 1 || first.trim() === "" || !PLAIN_ASCII.test(first)) {
			return reply
				.status(400)
				.header("content-type", "text/html; charset=utf-8")
				.send(page("Sign-in failed", "<p>Enter your email address and password.</p>"));
		}
		const login = first.slice(0, MAX_LOGIN_LENGTH);
		const target = `login:${accountKey(login)}`;
		const stamp = await passwordStamp(db, config.OIDC_ISSUER_URL, login);
		const knownDevice = isKnownDevice(request, config, login, stamp);
		if (await refused(request, login, target, knownDevice)) return refuse(reply);

		const giveBack = (): void => {
			throttle.passwordGiveBack(request.ip);
			if (!knownDevice) throttle.accountGiveBack(login);
		};
		let answer: Response;
		try {
			answer = await sendToDex(request, form, dexUrl);
		} catch (error) {
			giveBack();
			request.log.error({ err: error }, "dex did not answer a password post");
			return reply
				.status(502)
				.header("content-type", "text/html; charset=utf-8")
				.send(UNAVAILABLE_PAGE);
		}

		const outcome = dexOutcome(answer.status);
		if (outcome === "failure") {
			if (knownDevice) throttle.accountFailed(login);
			await audit(request, "auth.password_failed", target, {});
		} else {
			giveBack();
		}
		return passBack(reply, answer, outcome === "success" ? { login, stamp } : null);
	}
}
