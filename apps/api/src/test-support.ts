import { createOidcClient } from "@portikus/auth";
import {
	CookieJar,
	csrfHeaders,
	loginAs,
	MOCK_USERS,
	type MockUser,
} from "@portikus/auth/testing";
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
		SIGNIN_START_LIMIT_PER_MINUTE: 60,
		PASSWORD_ATTEMPT_LIMIT_PER_10_MINUTES: 30,
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

/** What one student owns in the authorization matrix world. */
export interface MatrixStudent {
	jar: CookieJar;
	userId: string;
	email: string;
	workspaceId: string;
	label: string;
	agentToken: string;
	projectId: string;
	projectName: string;
	projectSlug: string;
	terminalId: string;
	terminalName: string;
}

export interface MatrixWorld {
	a: MatrixStudent;
	b: MatrixStudent;
	admin: CookieJar;
	disabled: CookieJar;
}

/** A mock user the matrix signs in and then disables. */
export const DISABLED_MOCK_USER: MockUser = {
	sub: "erin",
	email: "erin@example.edu",
	name: "Erin Disabled",
	groups: ["portikus-students"],
};

let matrixWorlds = 0;

async function matrixStudent(
	app: FastifyInstance,
	db: Kysely<Database>,
	user: "alice" | "bob",
	agentToken: string,
): Promise<MatrixStudent> {
	const jar = new CookieJar();
	await loginAs(app, user, jar);
	const created = await app.inject({
		method: "POST",
		url: "/workspaces",
		headers: csrfHeaders(jar, PUBLIC_URL),
	});
	const workspaceId = created.json().id as string;
	const row = await db
		.updateTable("workspaces")
		.set({
			state: "running",
			agent_address: "127.0.0.1",
			agent_token: agentToken,
			updated_at: new Date().toISOString(),
		})
		.where("id", "=", workspaceId)
		.returning(["label", "owner_user_id"])
		.executeTakeFirstOrThrow();

	const projectName = `${user}-secret-project`;
	const project = await app.inject({
		method: "POST",
		url: `/workspaces/${workspaceId}/projects`,
		headers: csrfHeaders(jar, PUBLIC_URL),
		payload: { name: projectName, source: "new" },
	});
	if (project.statusCode !== 201) {
		throw new Error(`project create answered ${project.statusCode}`);
	}
	const projectId = project.json().id as string;

	const terminalName = `${user}-secret-terminal`;
	const terminal = await app.inject({
		method: "POST",
		url: `/workspaces/${workspaceId}/terminals`,
		headers: csrfHeaders(jar, PUBLIC_URL),
		payload: { name: terminalName, projectId },
	});
	if (terminal.statusCode !== 201) {
		throw new Error(`terminal create answered ${terminal.statusCode}`);
	}

	return {
		jar,
		userId: row.owner_user_id,
		email: MOCK_USERS[user]?.email ?? "",
		workspaceId,
		label: row.label,
		agentToken,
		projectId,
		projectName,
		projectSlug: project.json().slug as string,
		terminalId: terminal.json().id as string,
		terminalName,
	};
}

/**
 * The world of the authorization matrix (Epic 12a, "The matrix"): students A
 * and B, each with a running workspace on the fake agent, a project, and a
 * terminal; an administrator who owns nothing; and a disabled user whose
 * session row is still there. The mock provider must know
 * `DISABLED_MOCK_USER`, and the app's AGENT_PORT must be the fake agent's,
 * started with `agentToken`.
 */
export async function buildMatrixWorld(
	app: FastifyInstance,
	db: Kysely<Database>,
	agentToken: string,
): Promise<MatrixWorld> {
	// The worker seeds this row in production; the admin routes need it.
	await db
		.insertInto("settings")
		.values({ id: 1, shutdown_grace_seconds: 900 })
		.onConflict((oc) => oc.doNothing())
		.execute();
	// A new key per world gives each one an empty directory on the fake agent.
	matrixWorlds += 1;
	const a = await matrixStudent(app, db, "alice", `${agentToken}:a${matrixWorlds}`);
	const b = await matrixStudent(app, db, "bob", `${agentToken}:b${matrixWorlds}`);
	const admin = new CookieJar();
	await loginAs(app, "carol", admin);
	const disabled = new CookieJar();
	await loginAs(app, DISABLED_MOCK_USER.sub, disabled);
	await db
		.updateTable("users")
		.set({ disabled_at: new Date().toISOString() })
		.where("oidc_subject", "=", DISABLED_MOCK_USER.sub)
		.execute();
	return { a, b, admin, disabled };
}
