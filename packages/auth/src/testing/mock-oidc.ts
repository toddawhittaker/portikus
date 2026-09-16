import * as crypto from "node:crypto";
import type { AddressInfo } from "node:net";
import Fastify from "fastify";
import { exportJWK, generateKeyPair, type JWK, type KeyObject, SignJWT } from "jose";

/**
 * A small OIDC provider for tests, local development, and the pilot VM.
 * It is deliberately not a real identity provider: it accepts any user
 * from its fixed table without a password. It binds to loopback only and
 * its systemd unit is disabled by default (ADR 0008).
 */

export const MOCK_GROUPS = {
	student: "portikus-students",
	admin: "portikus-administrators",
} as const;

export interface MockUser {
	sub: string;
	email: string;
	name: string;
	groups: string[];
}

export const MOCK_USERS: Record<string, MockUser> = {
	alice: {
		sub: "alice",
		email: "alice@example.edu",
		name: "Alice Student",
		groups: [MOCK_GROUPS.student],
	},
	bob: {
		sub: "bob",
		email: "bob@example.edu",
		name: "Bob Student",
		groups: [MOCK_GROUPS.student],
	},
	carol: {
		sub: "carol",
		email: "carol@example.edu",
		name: "Carol Admin",
		groups: [MOCK_GROUPS.admin],
	},
	dave: {
		sub: "dave",
		email: "dave@example.edu",
		name: "Dave Nobody",
		groups: [],
	},
};

export const MOCK_CLIENT_ID = "portikus-dev";
export const MOCK_CLIENT_SECRET = "portikus-dev-secret";

export interface MockOidcOptions {
	port?: number;
	/** Public issuer URL. Its path becomes the route prefix, so it works behind a proxy at /mock-idp. */
	issuer?: string;
	users?: Record<string, MockUser>;
}

export interface MockOidcProvider {
	issuer: string;
	port: number;
	users: Record<string, MockUser>;
	close: () => Promise<void>;
}

interface PendingCode {
	user: MockUser;
	nonce: string | null;
	codeChallenge: string;
	redirectUri: string;
	expiresAt: number;
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function s256(verifier: string): string {
	return crypto.createHash("sha256").update(verifier).digest("base64url");
}

function stringParam(query: unknown, name: string): string | null {
	const value = (query as Record<string, unknown> | null)?.[name];
	return typeof value === "string" && value.length > 0 ? value : null;
}

export async function startMockOidcProvider(
	options: MockOidcOptions = {},
): Promise<MockOidcProvider> {
	const users = options.users ?? MOCK_USERS;
	const app = Fastify({ logger: false });

	// The token endpoint is form-encoded; parse it without another dependency.
	app.addContentTypeParser(
		"application/x-www-form-urlencoded",
		{ parseAs: "string" },
		(_req, body, done) => {
			done(null, Object.fromEntries(new URLSearchParams(body as string)));
		},
	);

	const { publicKey, privateKey } = await generateKeyPair("RS256", {
		extractable: true,
	});
	const jwk: JWK = await exportJWK(publicKey as KeyObject);
	const kid = "mock-key-1";
	jwk.kid = kid;
	jwk.alg = "RS256";
	jwk.use = "sig";

	const codes = new Map<string, PendingCode>();
	const accessTokens = new Map<string, MockUser>();

	// Issuer is known up front unless we are picking a port, in which case
	// the prefix is empty and the issuer is filled in after listening.
	const declaredIssuer = options.issuer ?? null;
	const prefix = declaredIssuer
		? new URL(declaredIssuer).pathname.replace(/\/$/, "")
		: "";
	let issuer = declaredIssuer ?? "";

	app.get(`${prefix}/.well-known/openid-configuration`, async () => ({
		issuer,
		authorization_endpoint: `${issuer}/authorize`,
		token_endpoint: `${issuer}/token`,
		userinfo_endpoint: `${issuer}/userinfo`,
		jwks_uri: `${issuer}/jwks`,
		response_types_supported: ["code"],
		grant_types_supported: ["authorization_code"],
		subject_types_supported: ["public"],
		id_token_signing_alg_values_supported: ["RS256"],
		scopes_supported: ["openid", "profile", "email", "groups"],
		claims_supported: ["sub", "email", "name", "groups"],
		token_endpoint_auth_methods_supported: [
			"client_secret_basic",
			"client_secret_post",
		],
		code_challenge_methods_supported: ["S256"],
	}));

	app.get(`${prefix}/jwks`, async () => ({ keys: [jwk] }));

	app.get(`${prefix}/authorize`, async (request, reply) => {
		const q = request.query;
		const clientId = stringParam(q, "client_id");
		const redirectUri = stringParam(q, "redirect_uri");
		const challenge = stringParam(q, "code_challenge");
		const method = stringParam(q, "code_challenge_method");
		const state = stringParam(q, "state");
		const nonce = stringParam(q, "nonce");

		if (clientId !== MOCK_CLIENT_ID) {
			return reply.code(400).send({ error: "invalid_client" });
		}
		if (!redirectUri || !URL.canParse(redirectUri)) {
			return reply
				.code(400)
				.send({ error: "invalid_request", error_description: "redirect_uri" });
		}
		if (!challenge || method !== "S256") {
			return reply
				.code(400)
				.send({ error: "invalid_request", error_description: "code_challenge" });
		}

		const userKey = stringParam(q, "user");
		if (!userKey) {
			const base = new URL(`${issuer}/authorize`);
			for (const [key, value] of Object.entries(
				request.query as Record<string, string>,
			)) {
				base.searchParams.set(key, value);
			}
			const links = Object.entries(users)
				.map(([key, user]) => {
					const href = new URL(base);
					href.searchParams.set("user", key);
					return `<li><a data-testid="mock-user-${escapeHtml(key)}" href="${escapeHtml(href.href)}">${escapeHtml(user.name)}</a></li>`;
				})
				.join("\n");
			return reply
				.type("text/html; charset=utf-8")
				.send(
					`<!doctype html><html><head><title>Mock identity provider</title></head><body><h1>Mock identity provider</h1><p>Choose a user to sign in as.</p><ul>\n${links}\n</ul></body></html>`,
				);
		}

		const user = users[userKey];
		if (!user) {
			return reply
				.code(400)
				.send({ error: "invalid_request", error_description: "unknown user" });
		}

		const code = crypto.randomBytes(24).toString("base64url");
		codes.set(code, {
			user,
			nonce,
			codeChallenge: challenge,
			redirectUri,
			expiresAt: Date.now() + 60_000,
		});

		const target = new URL(redirectUri);
		target.searchParams.set("code", code);
		if (state) {
			target.searchParams.set("state", state);
		}
		return reply.redirect(target.href, 302);
	});

	app.post(`${prefix}/token`, async (request, reply) => {
		const body = (request.body ?? {}) as Record<string, string>;

		let clientId = body.client_id;
		let clientSecret = body.client_secret;
		const authHeader = request.headers.authorization;
		if (authHeader?.startsWith("Basic ")) {
			const decoded = Buffer.from(authHeader.slice(6), "base64").toString("utf8");
			const separator = decoded.indexOf(":");
			clientId = decodeURIComponent(decoded.slice(0, separator));
			clientSecret = decodeURIComponent(decoded.slice(separator + 1));
		}
		if (clientId !== MOCK_CLIENT_ID || clientSecret !== MOCK_CLIENT_SECRET) {
			return reply.code(401).send({ error: "invalid_client" });
		}
		if (body.grant_type !== "authorization_code") {
			return reply.code(400).send({ error: "unsupported_grant_type" });
		}

		const code = body.code;
		const pending = code ? codes.get(code) : undefined;
		if (!code || !pending) {
			return reply.code(400).send({ error: "invalid_grant" });
		}
		// Authorization codes are single use.
		codes.delete(code);

		if (pending.expiresAt < Date.now()) {
			return reply
				.code(400)
				.send({ error: "invalid_grant", error_description: "expired" });
		}
		if (body.redirect_uri !== pending.redirectUri) {
			return reply
				.code(400)
				.send({ error: "invalid_grant", error_description: "redirect_uri" });
		}
		if (!body.code_verifier || s256(body.code_verifier) !== pending.codeChallenge) {
			return reply
				.code(400)
				.send({ error: "invalid_grant", error_description: "pkce" });
		}

		const now = Math.floor(Date.now() / 1000);
		const idToken = await new SignJWT({
			email: pending.user.email,
			name: pending.user.name,
			groups: pending.user.groups,
			...(pending.nonce ? { nonce: pending.nonce } : {}),
		})
			.setProtectedHeader({ alg: "RS256", kid })
			.setIssuer(issuer)
			.setSubject(pending.user.sub)
			.setAudience(MOCK_CLIENT_ID)
			.setIssuedAt(now)
			.setExpirationTime(now + 3600)
			.sign(privateKey);

		const accessToken = crypto.randomBytes(24).toString("base64url");
		accessTokens.set(accessToken, pending.user);

		return reply.send({
			access_token: accessToken,
			token_type: "Bearer",
			expires_in: 3600,
			id_token: idToken,
		});
	});

	app.get(`${prefix}/userinfo`, async (request, reply) => {
		const header = request.headers.authorization;
		const user = header?.startsWith("Bearer ")
			? accessTokens.get(header.slice(7))
			: undefined;
		if (!user) {
			return reply.code(401).send({ error: "invalid_token" });
		}
		return reply.send({
			sub: user.sub,
			email: user.email,
			name: user.name,
			groups: user.groups,
		});
	});

	await app.listen({ host: "127.0.0.1", port: options.port ?? 0 });
	const port = (app.server.address() as AddressInfo).port;
	if (!declaredIssuer) {
		issuer = `http://127.0.0.1:${port}`;
	}

	return {
		issuer,
		port,
		users,
		close: () => app.close(),
	};
}
