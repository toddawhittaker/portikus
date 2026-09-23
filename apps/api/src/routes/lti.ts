import { createHash, createPublicKey } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import {
	checkLaunchState,
	consumeLoginState,
	createKeySetSource,
	isOnOrigin,
	type LtiLaunch,
	type LtiLoginParams,
	type LtiLoginStatesTable,
	type LtiPlatform,
	loadPlatformsFile,
	ltiStateCookieName,
	ltiStateCookieOptions,
	type Role,
	saveLoginState,
	startLtiLogin,
	upsertUser,
	validateLaunchToken,
} from "@portikus/auth";
import type { ApiConfig } from "@portikus/config";
import type { ApiError } from "@portikus/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Kysely } from "kysely";
import { toAuthOptions } from "../auth-options.js";
import type { ServerDeps } from "../server.js";
import { startSession } from "./start-session.js";

/** What the API loaded at start for LTI (docs/EPIC-13.md rulings 14 and 15). */
export interface LtiDeps {
	platforms: LtiPlatform[];
	/** The tool's private key in PEM; only its public half is ever served. */
	toolKeyPem: string | null;
}

/**
 * Load the platforms file at start. Ansible always sets the variables, so a
 * missing file means LTI is off; a file that is there but wrong throws
 * PlatformsFileError and stops the start (docs/EPIC-13.md ruling 14).
 */
export async function loadLtiDeps(
	config: Pick<ApiConfig, "LTI_PLATFORMS_FILE" | "LTI_TOOL_KEY_FILE">,
): Promise<LtiDeps | undefined> {
	const file = config.LTI_PLATFORMS_FILE;
	if (!file || !existsSync(file)) return undefined;
	const keyFile = config.LTI_TOOL_KEY_FILE;
	return {
		platforms: await loadPlatformsFile(file),
		toolKeyPem: keyFile && existsSync(keyFile) ? readFileSync(keyFile, "utf8") : null,
	};
}

const LOGIN_PARAMS = [
	"iss",
	"login_hint",
	"target_link_uri",
	"lti_message_hint",
	"client_id",
	"lti_deployment_id",
] as const;

const COULD_NOT_FINISH =
	"Portikus could not finish opening here. Open it again from your course; if this keeps happening, ask your instructor to set Portikus to open in a new window.";
const COULD_NOT_SIGN_IN =
	"Portikus could not sign you in from your course. Open it again from your course; if this keeps happening, ask your instructor.";
const NOT_AUTHORIZED = "Your account is not authorized to use Portikus.";
const BAD_LOGIN =
	"Portikus did not recognise this link from your course. Ask your instructor to check how Portikus is set up.";

function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

/**
 * A small server-rendered page that works inside an LMS frame: no script,
 * the design tokens' colours inline, light and dark (ruling 17).
 */
function page(heading: string, sentence: string, form = ""): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(heading)} - Portikus</title>
<style>
:root { color-scheme: light dark; --surface: #f6f4ef; --raised: #fdfcfa; --line: #dcd7cc; --ink: #23211d; --muted: #5a554c; --accent: #2c6a66; --accent-hover: #22524f; --on-accent: #ffffff; }
@media (prefers-color-scheme: dark) { :root { --surface: #171614; --raised: #211f1c; --line: #35322d; --ink: #ece8df; --muted: #aba498; --accent: #7cc2b9; --accent-hover: #9bd3cb; --on-accent: #0f201e; } }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--surface); color: var(--ink); font: 16px/1.5 "Public Sans", system-ui, sans-serif; }
main { max-width: 32rem; margin: 1.5rem; padding: 1.5rem; background: var(--raised); border: 1px solid var(--line); border-radius: 8px; }
h1 { margin: 0 0 0.5rem; font-size: 1.25rem; }
p { margin: 0; color: var(--muted); }
form { margin-top: 1rem; }
button { font: inherit; font-weight: 600; padding: 0.5rem 1rem; border: 0; border-radius: 6px; background: var(--accent); color: var(--on-accent); cursor: pointer; }
button:hover { background: var(--accent-hover); }
button:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }
</style>
</head>
<body>
<main>
<h1>${escapeHtml(heading)}</h1>
<p>${escapeHtml(sentence)}</p>
${form}</main>
</body>
</html>
`;
}

/** Re-submit the login initiation as a top-level request in a new tab. */
function newTabPage(params: LtiLoginParams): string {
	const fields = LOGIN_PARAMS.filter((name) => params[name] !== undefined)
		.map(
			(name) =>
				`<input type="hidden" name="${name}" value="${escapeHtml(params[name] ?? "")}">`,
		)
		.join("\n");
	const form = `<form method="post" action="/lti/login" target="_blank">
${fields}
<button type="submit">Open Portikus in a new tab</button>
</form>
`;
	return page(
		"Open Portikus in a new tab",
		"Your course opened Portikus inside a frame, where it cannot run. Open it in its own tab to continue.",
		form,
	);
}

function isFramed(request: FastifyRequest): boolean {
	const dest = request.headers["sec-fetch-dest"];
	return dest === "iframe" || dest === "frame";
}

/** Only the known parameters, and only when each is a single string. */
function loginParams(source: unknown): LtiLoginParams {
	const params: LtiLoginParams = {};
	if (typeof source !== "object" || source === null) return params;
	for (const name of LOGIN_PARAMS) {
		const value = (source as Record<string, unknown>)[name];
		if (typeof value === "string") params[name] = value;
	}
	return params;
}

/** The public half of the tool key, with its SHA-256 thumbprint as `kid` (ruling 15). */
export function toolJwks(pem: string | null): { keys: Record<string, string>[] } {
	if (!pem) return { keys: [] };
	const jwk = createPublicKey(pem).export({ format: "jwk" });
	const { kty, n, e } = jwk as { kty: string; n: string; e: string };
	// RFC 7638: the required members, in lexical order, no whitespace.
	const kid = createHash("sha256")
		.update(JSON.stringify({ e, kty, n }))
		.digest("base64url");
	return { keys: [{ kty, n, e, kid, alg: "RS256", use: "sig" }] };
}

/** Only the path and query of `target_link_uri`, and only on our origin (ruling 18). */
function targetPath(uri: string, publicUrl: string): string {
	if (!isOnOrigin(uri, publicUrl)) return "/";
	const url = new URL(uri);
	return `${url.pathname}${url.search}`;
}

/** LTI 1.3 login initiation, launch, and the tool keyset (docs/EPIC-13.md). */
export function registerLtiRoutes(
	app: FastifyInstance,
	{ db, config, lti }: ServerDeps,
): void {
	const auth = toAuthOptions(config);
	const publicUrl = config.PUBLIC_URL;
	const stateCookie = ltiStateCookieName(publicUrl);
	const keySets = createKeySetSource();
	const jwks = toolJwks(lti?.toolKeyPem ?? null);

	// Only the registered platforms may frame these pages; the login form
	// then redirects to their authorization endpoints (ruling 17).
	const origins = [
		...new Set(lti?.platforms.map((p) => new URL(p.authLoginUrl).origin)),
	];
	const ancestors = origins.length > 0 ? origins.join(" ") : "'none'";
	const csp = [
		"default-src 'none'",
		"style-src 'unsafe-inline'",
		`form-action 'self' ${origins.join(" ")}`.trim(),
		"base-uri 'none'",
		`frame-ancestors ${ancestors}`,
	].join("; ");

	function notFound(reply: FastifyReply) {
		const body: ApiError = { code: "NOT_FOUND", message: "Not found." };
		return reply.status(404).send(body);
	}

	function html(reply: FastifyReply, status: number, body: string) {
		return reply.status(status).type("text/html; charset=utf-8").send(body);
	}

	async function audit(
		action: string,
		actor: string,
		target: string,
		result: string,
		metadata: Record<string, unknown>,
	): Promise<void> {
		await db
			.insertInto("audit_events")
			.values({ actor, target, action, result, metadata: JSON.stringify(metadata) })
			.execute();
	}

	/** Refuse a launch: an audit row and a log line with the reason code only. */
	async function refuseLaunch(
		request: FastifyRequest,
		reply: FastifyReply,
		reason: string,
		platform: LtiPlatform | null,
	) {
		request.log.info({ reason }, "lti launch refused");
		await audit("auth.login", "unknown", "unknown", "failed", {
			method: "lti",
			...(platform ? { platform: platform.name } : {}),
			reason,
		});
		const stateProblem =
			reason === "framed" || reason === "state_missing" || reason === "state_mismatch";
		return html(
			reply,
			stateProblem ? 400 : 401,
			page(
				"Portikus could not open",
				stateProblem ? COULD_NOT_FINISH : COULD_NOT_SIGN_IN,
			),
		);
	}

	/** The course and this user's membership in it, added or refreshed (ruling 27). */
	async function recordMembership(
		launch: LtiLaunch,
		userId: string,
		now: string,
	): Promise<void> {
		if (!launch.context) return;
		const course = await db
			.insertInto("lti_contexts")
			.values({
				platform_issuer: launch.platform.issuer,
				context_id: launch.context.id,
				title: launch.context.title,
				platform_name: launch.platform.name,
			})
			.onConflict((oc) =>
				oc.columns(["platform_issuer", "context_id"]).doUpdateSet({
					title: launch.context?.title ?? "",
					platform_name: launch.platform.name,
					updated_at: now,
				}),
			)
			.returning("id")
			.executeTakeFirstOrThrow();
		await db
			.insertInto("lti_memberships")
			.values({
				context_id: course.id,
				user_id: userId,
				role: launch.role,
				last_launch_at: now,
			})
			.onConflict((oc) =>
				oc
					.columns(["context_id", "user_id"])
					.doUpdateSet({ role: launch.role, last_launch_at: now }),
			)
			.execute();
	}

	async function login(request: FastifyRequest, reply: FastifyReply) {
		reply.header("content-security-policy", csp);
		if (!lti) return notFound(reply);
		const params = loginParams(request.method === "GET" ? request.query : request.body);
		if (isFramed(request)) return html(reply, 200, newTabPage(params));

		const started = startLtiLogin(lti.platforms, publicUrl, params);
		if (!started.ok) {
			request.log.info({ reason: started.reason }, "lti login refused");
			return html(reply, 400, page("Portikus could not open", BAD_LOGIN));
		}
		await saveLoginState(db, {
			state: started.state,
			nonce: started.nonce,
			platformIssuer: started.platform.issuer,
			clientId: started.platform.clientId,
		});
		reply.setCookie(stateCookie, started.state, ltiStateCookieOptions(publicUrl));
		return reply.redirect(started.redirectUrl, 302);
	}

	app.get("/lti/login", login);
	app.post("/lti/login", login);

	app.post("/lti/launch", async (request, reply) => {
		reply.header("content-security-policy", csp);
		if (!lti) return notFound(reply);
		const platforms = lti.platforms;

		// Neither the frame case nor a missing cookie touches the state row.
		if (isFramed(request)) return refuseLaunch(request, reply, "framed", null);
		const form = (request.body ?? {}) as Record<string, unknown>;
		const formState = typeof form.state === "string" ? form.state : undefined;
		const idToken = typeof form.id_token === "string" ? form.id_token : "";
		const cookieState = request.cookies[stateCookie];
		reply.clearCookie(stateCookie, ltiStateCookieOptions(publicUrl));
		const stateProblem = checkLaunchState(formState, cookieState);
		if (stateProblem) return refuseLaunch(request, reply, stateProblem, null);

		// The state row is deleted in the same transaction that checks the
		// token against it, so the state and its nonce are single use (ruling 16).
		const result = await db.transaction().execute(async (trx) => {
			const loginState = await consumeLoginState(
				// The db schema types expires_at as a column type, the store as a Date.
				trx as unknown as Kysely<LtiLoginStatesTable>,
				formState ?? "",
			);
			if (!loginState) {
				return { ok: false as const, reason: "state_missing" as const, platform: null };
			}
			return validateLaunchToken({
				idToken,
				loginState,
				platforms,
				publicUrl,
				keySets,
			});
		});
		if (!result.ok) return refuseLaunch(request, reply, result.reason, result.platform);

		const { launch } = result;
		const role: Role = launch.role;
		const user = await upsertUser(
			db,
			{
				issuer: `lti:${launch.platform.issuer}`,
				subject: launch.subject,
				email: launch.email,
				displayName: launch.displayName,
				preferredUsername: null,
			},
			role,
		);
		if (user.previousRole !== null && user.previousRole !== role) {
			await audit("user.role_changed", "identity-provider", user.id, "ok", {
				from: user.previousRole,
				to: role,
				source: "lti",
			});
		}
		const metadata = { method: "lti", platform: launch.platform.name, role };
		if (user.disabledAt) {
			request.log.info({ reason: "disabled" }, "lti launch refused");
			await audit("auth.login", `user:${user.id}`, user.id, "denied", metadata);
			return html(reply, 403, page("Portikus could not open", NOT_AUTHORIZED));
		}

		await recordMembership(launch, user.id, new Date().toISOString());
		await startSession(db, auth, reply, user.id);
		await audit("auth.login", `user:${user.id}`, user.id, "ok", metadata);
		return reply.redirect(targetPath(launch.targetLinkUri, publicUrl), 303);
	});

	app.get("/lti/jwks", async (_request, reply) => {
		reply.header("content-security-policy", csp);
		if (!lti) return notFound(reply);
		return reply.send(jwks);
	});
}
