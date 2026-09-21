import * as client from "openid-client";
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

export interface OidcClient {
	buildLoginRedirect(): Promise<{ url: string; state: LoginState }>;
	completeLogin(
		callbackUrl: URL,
		state: LoginState,
	): Promise<{ identity: OidcIdentity; claims: Record<string, unknown> }>;
}

function pickString(claims: Record<string, unknown>, key: string): string | null {
	const value = claims[key];
	return typeof value === "string" && value.length > 0 ? value : null;
}

export function createOidcClient(opts: AuthOptions): OidcClient {
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
				opts.issuerUrl.startsWith("http:")
					? { execute: [client.allowInsecureRequests] }
					: {},
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
		async buildLoginRedirect() {
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

			let claims: Record<string, unknown> = { ...idClaims };
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
			};
		},
	};
}
