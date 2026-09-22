import { defineConfig, devices } from "@playwright/test";
import {
	API_ORIGIN,
	API_PORT,
	FAKE_AGENT_PORT,
	MOCK_ISSUER as MOCK_OIDC_ISSUER,
	OIDC_PORT,
	WEB_PORT,
	WEB_ORIGIN as WEB_URL,
} from "./e2e/ports";

const FAKE_AGENT_TOKEN = "e2e-agent-token";

// The throwaway PostgreSQL from docs/WORKFLOW.md, "Local PostgreSQL for
// database tests"; CI points TEST_DATABASE_URL at its service container.
// `pnpm test:e2e` points this at a database created for the run. A direct
// `playwright test` uses the shared database, which can refuse to migrate
// when its history names a migration this checkout does not contain.
const databaseUrl =
	process.env.TEST_DATABASE_URL ??
	"postgres://postgres:portikus@127.0.0.1:55432/portikus_test";

export default defineConfig({
	testDir: "./e2e",
	fullyParallel: true,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 1 : 0,
	reporter: "list",
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
				MOCK_OIDC_PORT: String(OIDC_PORT),
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
			url: `${API_ORIGIN}/health`,
			env: {
				NODE_ENV: "test",
				PORT: String(API_PORT),
				AGENT_PORT: String(FAKE_AGENT_PORT),
				DATABASE_URL: databaseUrl,
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
			env: { PORTIKUS_WEB_PORT: String(WEB_PORT), PORTIKUS_API_PORT: String(API_PORT) },
			reuseExistingServer: !process.env.CI,
			timeout: 120_000,
		},
	],
});
