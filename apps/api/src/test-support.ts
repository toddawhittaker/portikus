import { createOidcClient } from "@portikus/auth";
import type { ApiConfig } from "@portikus/config";
import type { Database } from "@portikus/db";
import { type Logger, silentLogger } from "@portikus/observability";
import type { FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import { toAuthOptions } from "./auth-options.js";
import { buildServer } from "./server.js";

export const PUBLIC_URL = "http://127.0.0.1:5173";

/** The API configuration the tests run against, pointed at the mock provider. */
export function testConfig(
	issuerUrl: string,
	overrides: Partial<ApiConfig> = {},
): ApiConfig {
	return {
		NODE_ENV: "test",
		PORT: 3000,
		LOG_LEVEL: "info",
		DATABASE_URL: process.env.TEST_DATABASE_URL ?? "",
		PRESENCE_TTL_SECONDS: 60,
		AGENT_PORT: 7400,
		WORKSPACE_HOME_SIZE_GIB: 25,
		WORKSPACE_DOCKER_SIZE_GIB: 20,
		WORKSPACE_RECOVERY_SIZE_GIB: 3,
		RECOVERY_RETENTION_DAYS: 14,
		PUBLIC_URL,
		OIDC_ISSUER_URL: issuerUrl,
		OIDC_CLIENT_ID: "portikus-dev",
		OIDC_CLIENT_SECRET: "portikus-dev-secret",
		OIDC_SCOPES: "openid profile email",
		OIDC_GROUPS_CLAIM: "groups",
		OIDC_STUDENT_GROUP: "portikus-students",
		OIDC_ADMIN_GROUP: "portikus-administrators",
		SESSION_COOKIE_SECRET: "test-session-secret",
		SESSION_TTL_SECONDS: 43200,
		PROJECT_TEMPLATES: "",
		projectTemplates: [],
		PREVIEW_SUFFIX: "preview.localhost",
		PREVIEW_PORT_MIN: 1024,
		PREVIEW_PORT_MAX: 65535,
		PREVIEW_DENIED_PORTS: "22,2375,2376,5432",
		PREVIEW_TICKET_TTL_SECONDS: 30,
		previewDeniedPorts: [22, 2375, 2376, 5432, 7400],
		...overrides,
	};
}

/**
 * Build a server wired to the mock provider on `issuerUrl`. Pass `logger`
 * when a test needs to read the API's own log lines.
 */
export function buildTestServer(
	db: Kysely<Database>,
	issuerUrl: string,
	overrides: Partial<ApiConfig> = {},
	logger: Logger = silentLogger(),
): FastifyInstance {
	const config = testConfig(issuerUrl, overrides);
	return buildServer({
		db,
		config,
		logger,
		oidc: createOidcClient(toAuthOptions(config)),
		// The registry must notice a workspace within one test's patience.
		previewPollIntervalMs: 50,
	});
}
