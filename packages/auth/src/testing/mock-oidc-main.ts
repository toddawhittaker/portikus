import { createLogger, LOG_LEVELS, type LogLevel } from "@portikus/observability";
import { startMockOidcProvider } from "./mock-oidc.js";

/** Standalone mock identity provider for local development and the pilot VM (ADR 0008). */

const port = Number(process.env.MOCK_OIDC_PORT ?? 3002);
const issuer = process.env.MOCK_OIDC_ISSUER ?? `http://127.0.0.1:${port}`;
const clientId = process.env.MOCK_OIDC_CLIENT_ID ?? "portikus-dev";
const clientSecret = process.env.MOCK_OIDC_CLIENT_SECRET ?? "portikus-dev-secret";
const redirectUri = process.env.MOCK_OIDC_REDIRECT_URI;

/** LOG_LEVEL from the environment, or info when it is missing or unknown. */
function envLevel(): LogLevel {
	const value = process.env.LOG_LEVEL;
	return LOG_LEVELS.find((level) => level === value) ?? "info";
}

const logger = createLogger({
	service: "mock-idp",
	level: envLevel(),
	pretty: process.env.NODE_ENV === "development",
});

if (!redirectUri) {
	logger.error(
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
	logger,
});

logger.info(
	{ port: provider.port, issuer: provider.issuer },
	"mock identity provider listening",
);

for (const signal of ["SIGTERM", "SIGINT"] as const) {
	process.on(signal, () => {
		void provider.close().then(() => process.exit(0));
	});
}
