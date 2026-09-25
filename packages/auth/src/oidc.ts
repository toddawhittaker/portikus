import * as client from "openid-client";
import { createOutboundFetch } from "./outbound-fetch.js";
import type { OidcIdentity } from "./sessions.js";
import type { AuthOptions } from "./types.js";

/**
 * Anything that went wrong talking to the identity provider. The message
 * is deliberately coarse: it must never contain tokens, codes, or the
 * client secret, because it is logged and may reach the browser.
 */
export class OidcError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "OidcError";
	}
}

export interface LoginState {
	verifier: string;
	state: string;
	nonce: string;
}

/** Why an otherwise valid sign-in was not admitted (docs/EPIC-14.md ruling 9). */
export type AdmissionRefusal = "tenant_not_allowed" | "domain_not_allowed";

export interface OidcClient {
	/**
	 * `prompt: "login"` asks the provider to re-authenticate the user, the
	 * standard OIDC way; linking an account uses it (docs/EPIC-13-1.md ruling 11).
	 */
	buildLoginRedirect(options?: {
		prompt?: "login";
	}): Promise<{ url: string; state: LoginState }>;
	completeLogin(
		callbackUrl: URL,
		state: LoginState,
	): Promise<{
		identity: OidcIdentity;
		claims: Record<string, unknown>;
		/** Non-null when the Entra tenant or Google domain check refused the ID token. */
		refusal: AdmissionRefusal | null;
	}>;
}

function pickString(claims: Record<string, unknown>, key: string): string | null {
	const value = claims[key];
	return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * The Entra `tid` and Google `hd` checks. They read only the signed ID
 * token's claims, and a missing claim is a refusal (ruling 9).
 */
function checkAdmission(
	idClaims: Record<string, unknown>,
	opts: AuthOptions,
): AdmissionRefusal | null {
	if (opts.provider === "entra") {
		const tid = pickString(idClaims, "tid")?.toLowerCase();
		const allowed = opts.allowedTenant?.toLowerCase();
		return allowed && tid === allowed ? null : "tenant_not_allowed";
	}
	if (opts.provider === "google") {
		const hd = pickString(idClaims, "hd")?.toLowerCase();
		return hd && (opts.allowedDomains ?? []).includes(hd) ? null : "domain_not_allowed";
	}
	return null;
}

export function createOidcClient(opts: AuthOptions): OidcClient {
	// Entra and Google put everything in the ID token; skipping userinfo
	// keeps a second host off the egress allow list (ruling 10).
	const useUserinfo = opts.provider !== "entra" && opts.provider !== "google";
	const outboundFetch = createOutboundFetch(opts.outboundProxyUrl);
	const redirectUri = new URL("/auth/callback", opts.publicUrl).href;
	// Discovery is lazy and memoised so the service starts even when the
	// identity provider is down, and retries after a failure.
	let discovery: Promise<client.Configuration> | null = null;

	const getConfig = async (): Promise<client.Configuration> => {
		if (!discovery) {
			const pending = client.discovery(
				new URL(opts.issuerUrl),
				opts.clientId,
				opts.clientSecret,
				undefined,
				{
					[client.customFetch]: outboundFetch,
					...(opts.issuerUrl.startsWith("http:")
						? { execute: [client.allowInsecureRequests] }
						: {}),
				},
			);
			discovery = pending;
			pending.catch(() => {
				if (discovery === pending) {
					discovery = null;
				}
			});
		}
		try {
			return await discovery;
		} catch {
			throw new OidcError("identity provider discovery failed");
		}
	};

	return {
		async buildLoginRedirect(options = {}) {
			const config = await getConfig();
			const verifier = client.randomPKCECodeVerifier();
			const challenge = await client.calculatePKCECodeChallenge(verifier);
			const state = client.randomState();
			const nonce = client.randomNonce();

			const url = client.buildAuthorizationUrl(config, {
				redirect_uri: redirectUri,
				scope: opts.scopes,
				code_challenge: challenge,
				code_challenge_method: "S256",
				state,
				nonce,
				...(options.prompt ? { prompt: options.prompt } : {}),
				// Only a hint for Google's account picker; the callback check decides.
				...(opts.provider === "google" && opts.allowedDomains?.[0]
					? { hd: opts.allowedDomains[0] }
					: {}),
			});

			return { url: url.href, state: { verifier, state, nonce } };
		},

		async completeLogin(callbackUrl, state) {
			const config = await getConfig();

			let tokens: client.TokenEndpointResponse & client.TokenEndpointResponseHelpers;
			try {
				tokens = await client.authorizationCodeGrant(config, callbackUrl, {
					pkceCodeVerifier: state.verifier,
					expectedState: state.state,
					expectedNonce: state.nonce,
				});
			} catch {
				throw new OidcError("the login could not be completed");
			}

			const idClaims = tokens.claims();
			if (!idClaims) {
				throw new OidcError("the identity provider returned no ID token claims");
			}

			const refusal = checkAdmission(idClaims, opts);

			let claims: Record<string, unknown> = { ...idClaims };
			if (useUserinfo) {
				try {
					const userinfo = await client.fetchUserInfo(
						config,
						tokens.access_token,
						idClaims.sub,
					);
					// Userinfo is the fresher source, so it wins on conflict.
					claims = { ...claims, ...userinfo };
				} catch {
					throw new OidcError("the userinfo request failed");
				}
			}

			const subject = pickString(claims, "sub");
			if (!subject) {
				throw new OidcError("the identity provider returned no subject");
			}
			const email = pickString(claims, "email");
			const preferredUsername = pickString(claims, "preferred_username");
			const displayName =
				pickString(claims, "name") ?? preferredUsername ?? email ?? subject;

			return {
				identity: {
					issuer: config.serverMetadata().issuer,
					subject,
					email,
					displayName,
					preferredUsername,
				},
				claims,
				refusal,
			};
		},
	};
}
