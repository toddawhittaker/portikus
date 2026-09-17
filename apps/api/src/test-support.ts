import { createOidcClient } from "@portikus/auth";
import type { ApiConfig } from "@portikus/config";
import type { Database } from "@portikus/db";
import type { FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import { toAuthOptions } from "./auth-options.js";
import { buildServer } from "./server.js";

export const PUBLIC_URL = "http://127.0.0.1:5173";

/** The API configuration the tests run against, pointed at the mock provider. */
export function testConfig(issuerUrl: string): ApiConfig {
	return {
		NODE_ENV: "test",
		PORT: 3000,
		DATABASE_URL: process.env.TEST_DATABASE_URL ?? "",
		PRESENCE_TTL_SECONDS: 60,
		AGENT_PORT: 7400,
		WORKSPACE_HOME_SIZE_GIB: 25,
		WORKSPACE_DOCKER_SIZE_GIB: 20,
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
	};
}

/** Build a server wired to the mock provider on `issuerUrl`. */
export function buildTestServer(
	db: Kysely<Database>,
	issuerUrl: string,
): FastifyInstance {
	const config = testConfig(issuerUrl);
	return buildServer({ db, config, oidc: createOidcClient(toAuthOptions(config)) });
}
