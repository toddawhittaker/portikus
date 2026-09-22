import { defineConfig, devices } from "@playwright/test";
import { createRunDatabase } from "./packages/db/dist/testing.js";

const MOCK_OIDC_ISSUER = "http://127.0.0.1:3002";
const WEB_URL = "http://127.0.0.1:5173";

/** The fake workspace agent the terminal tests attach to. */
export const FAKE_AGENT_PORT = 7400;
export const FAKE_AGENT_TOKEN = "e2e-agent-token";

// The throwaway PostgreSQL from docs/WORKFLOW.md, "Local PostgreSQL for
// database tests"; CI points TEST_DATABASE_URL at its service container.
const sharedDatabaseUrl =
	process.env.TEST_DATABASE_URL ??
	"postgres://postgres:portikus@127.0.0.1:55432/portikus_test";

// A fresh database for this run, migrated from this checkout. The shared
// database keeps whatever history the last checkout wrote, and Kysely will
// not migrate a history that names a migration this checkout does not have.
// Listing tests does not start the servers, so it keeps the shared URL and
// creates nothing.
const listing = process.argv.includes("--list");
const runDatabase = listing
	? { url: sharedDatabaseUrl, name: "" }
	: await createRunDatabase(sharedDatabaseUrl);
if (!listing) {
	process.env.TEST_DATABASE_URL = runDatabase.url;
	process.env.PORTIKUS_E2E_ADMIN_URL = sharedDatabaseUrl;
	process.env.PORTIKUS_E2E_DB_NAME = runDatabase.name;
}

export default defineConfig({
	testDir: "./e2e",
	fullyParallel: true,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 1 : 0,
	reporter: "list",
	globalTeardown: "./e2e/global-teardown.ts",
	use: {
		baseURL: WEB_URL,
		trace: "on-first-retry",
	},
	projects: [
		// Runs first and stops the suite if the servers belong to another run.
		{ name: "setup", testMatch: /environment\.setup\.ts$/ },
		{
			name: "chromium",
			use: { ...devices["Desktop Chrome"] },
			dependencies: ["setup"],
		},
	],
	webServer: [
		{
			// Stands in for the workspace agent, which normally runs inside a
			// container the browser tests do not start (see e2e/helpers.ts).
			command: "node e2e/fake-agent-server.mjs",
			port: FAKE_AGENT_PORT,
			env: {
				FAKE_AGENT_PORT: String(FAKE_AGENT_PORT),
				FAKE_AGENT_TOKEN: FAKE_AGENT_TOKEN,
			},
			reuseExistingServer: !process.env.CI,
			timeout: 120_000,
		},
		{
			command: "node packages/auth/dist/testing/mock-oidc-main.js",
			url: `${MOCK_OIDC_ISSUER}/.well-known/openid-configuration`,
			env: {
				MOCK_OIDC_PORT: "3002",
				MOCK_OIDC_ISSUER,
				MOCK_OIDC_CLIENT_ID: "portikus-dev",
				MOCK_OIDC_CLIENT_SECRET: "portikus-dev-secret",
				MOCK_OIDC_REDIRECT_URI: `${WEB_URL}/auth/callback`,
			},
			reuseExistingServer: !process.env.CI,
			timeout: 120_000,
		},
		{
			command: "node packages/db/dist/migrate.js && node apps/api/dist/index.js",
			url: "http://127.0.0.1:3000/health",
			env: {
				NODE_ENV: "test",
				PORT: "3000",
				AGENT_PORT: String(FAKE_AGENT_PORT),
				DATABASE_URL: runDatabase.url,
				PUBLIC_URL: WEB_URL,
				OIDC_ISSUER_URL: MOCK_OIDC_ISSUER,
				OIDC_CLIENT_ID: "portikus-dev",
				OIDC_CLIENT_SECRET: "portikus-dev-secret",
				OIDC_SCOPES: "openid profile email",
				OIDC_GROUPS_CLAIM: "groups",
				OIDC_STUDENT_GROUP: "portikus-students",
				OIDC_ADMIN_GROUP: "portikus-administrators",
				SESSION_COOKIE_SECRET: "e2e-session-secret-not-for-production-0000",
				SESSION_TTL_SECONDS: "3600",
				PRESENCE_TTL_SECONDS: "60",
				// One template, so projects.spec.ts can use the template option;
				// the "no templates" case fakes an empty list in the browser.
				PROJECT_TEMPLATES: "Starter=https://example.com/starter.git",
				WORKSPACE_HOME_SIZE_GIB: "25",
				WORKSPACE_DOCKER_SIZE_GIB: "20",
			},
			reuseExistingServer: !process.env.CI,
			timeout: 120_000,
		},
		{
			command: "pnpm --filter @portikus/web dev",
			url: WEB_URL,
			reuseExistingServer: !process.env.CI,
			timeout: 120_000,
		},
	],
});
