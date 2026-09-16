import { startMockOidcProvider } from "./mock-oidc.js";

/** Standalone mock identity provider for local development and the pilot VM (ADR 0008). */

const port = Number(process.env.MOCK_OIDC_PORT ?? 3002);
const issuer = process.env.MOCK_OIDC_ISSUER ?? `http://127.0.0.1:${port}`;
const clientId = process.env.MOCK_OIDC_CLIENT_ID ?? "portikus-dev";
const clientSecret = process.env.MOCK_OIDC_CLIENT_SECRET ?? "portikus-dev-secret";
const redirectUri = process.env.MOCK_OIDC_REDIRECT_URI;

if (!redirectUri) {
	console.error(
		"MOCK_OIDC_REDIRECT_URI is required; set it to <PUBLIC_URL>/auth/callback",
	);
	process.exit(1);
}

const provider = await startMockOidcProvider({
	port,
	issuer,
	clientId,
	clientSecret,
	redirectUris: [redirectUri],
});

console.log(`mock identity provider listening on 127.0.0.1:${provider.port}`);
console.log(`issuer ${provider.issuer}`);

for (const signal of ["SIGTERM", "SIGINT"] as const) {
	process.on(signal, () => {
		void provider.close().then(() => process.exit(0));
	});
}
