import {
	type AuthOptions,
	dexConnectorId,
	type LoginState,
	mapRole,
	type OidcClient,
	OidcError,
} from "@portikus/auth";
import {
	Role,
	type SigninSettings,
	SigninTestResult,
	SiteJobId,
	type SiteView,
} from "@portikus/contracts";
import { type Database, recordAudit } from "@portikus/db";
import type { FastifyRequest } from "fastify";
import type { Kysely } from "kysely";
import { z } from "zod";
import { requestMetadata } from "../sessions/start-session.js";

/**
 * The sign-in provider's trial check (ADR 0059): a test
 * sign-in an administrator starts, and the rules the page and the root job
 * share. A test sign-in never creates a user, a session or a role.
 */

const SIGNIN_TESTED = "settings.signin_tested";

/** Where a test sign-in returns, with `?test=passed` or `?test=failed`. */
const SIGNIN_PAGE = "/admin/signin";

/**
 * What the login cookie carries for a test sign-in. The cookie is signed,
 * so the callback can trust it names the administrator who started it.
 */
const SigninTestMarker = z
	.object({
		adminId: z.string().uuid(),
		/** The open trial the test checks; null when no trial is open. */
		trialId: SiteJobId.nullable(),
		/** The Dex connector the site's provider signs in through. */
		connector: z.string().min(1),
	})
	.strict();
export type SigninTestMarker = z.infer<typeof SigninTestMarker>;

/**
 * The test marker in a login cookie's state, null for an ordinary sign-in,
 * or "invalid" when a marker is there but wrong. The caller refuses an
 * invalid one: a broken test must never finish as a real sign-in.
 */
export function signinTestOf(state: LoginState): SigninTestMarker | "invalid" | null {
	if (!Object.hasOwn(state, "signinTest")) return null;
	const parsed = SigninTestMarker.safeParse(
		(state as { signinTest?: unknown }).signinTest,
	);
	return parsed.success ? parsed.data : "invalid";
}

/** Dex's connector ID for each provider; "dex" means only local passwords. */
export function providerConnector(provider: SiteView["provider"]): string {
	return provider === "dex" ? "local" : provider;
}

/** What a client secret was issued for, as the root job compares it. */
function secretIdentity(settings: {
	provider: string;
	entraTenantId?: string | null;
	oidcIssuer?: string | null;
	clientId?: string | null;
}): string {
	return JSON.stringify([
		settings.provider,
		settings.provider === "entra" ? (settings.entraTenantId ?? "") : "",
		settings.provider === "oidc" ? (settings.oidcIssuer ?? "") : "",
		settings.clientId ?? "",
	]);
}

/**
 * The root job's `missing_secret` rule, checked first so the page says so at
 * once: an upstream provider needs a new secret unless one is stored and
 * the provider, tenant, issuer and client ID are unchanged (ADR 0059).
 */
export function needsNewSecret(view: SiteView, settings: SigninSettings): boolean {
	if (settings.provider === "dex" || settings.clientSecret !== null) return false;
	if (!view.clientSecretSet) return true;
	return secretIdentity(view) !== secretIdentity(settings);
}

const TestMetadata = z.object({
	result: z.enum(["passed", "failed"]),
	role: Role.nullable(),
	connector: z.string().nullable(),
	trialId: SiteJobId.nullable(),
});

/** The newest test sign-in, from its audit row (ADR 0059). */
export async function latestSigninTest(
	db: Kysely<Database>,
): Promise<SigninTestResult | null> {
	const row = await db
		.selectFrom("audit_events")
		.select(["metadata", "at"])
		.where("action", "=", SIGNIN_TESTED)
		.orderBy("id", "desc")
		.limit(1)
		.executeTakeFirst();
	const metadata = TestMetadata.safeParse(row?.metadata);
	if (!row || !metadata.success) return null;
	return SigninTestResult.parse({ ...metadata.data, at: row.at.toISOString() });
}

/**
 * The callback for a test sign-in. It maps the provider's groups to a role
 * and writes one audit row, never an email; it writes no user row, no
 * session and no role change. Returns where to send the browser.
 */
export async function finishSigninTest(
	deps: { db: Kysely<Database>; oidc: OidcClient; auth: AuthOptions },
	request: FastifyRequest,
	callbackUrl: URL,
	state: LoginState,
	marker: SigninTestMarker,
): Promise<string> {
	// Only the administrator who started the test, still signed in, gets a result.
	const admin = request.user;
	if (!admin || admin.id !== marker.adminId || admin.role !== "administrator") {
		return SIGNIN_PAGE;
	}
	let role: Role | null = null;
	let connector: string | null = null;
	try {
		const { identity, claims } = await deps.oidc.completeLogin(callbackUrl, state);
		role = mapRole(claims, deps.auth);
		connector = dexConnectorId(identity.subject);
	} catch (error) {
		if (!(error instanceof OidcError)) throw error;
	}
	// A pass needs the provider's own connector, so the local password cannot stand in for it.
	const result = role !== null && connector === marker.connector ? "passed" : "failed";
	await recordAudit(deps.db, {
		actor: `user:${admin.id}`,
		target: marker.trialId ?? "none",
		action: SIGNIN_TESTED,
		result: result === "passed" ? "ok" : "failed",
		metadata: {
			result,
			role,
			connector,
			trialId: marker.trialId,
			...requestMetadata(request),
		},
	});
	return `${SIGNIN_PAGE}?test=${result}`;
}
