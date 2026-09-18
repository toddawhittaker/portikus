import react from "@vitejs/plugin-react";
import { configDefaults, defineConfig } from "vitest/config";

const workspaceAliases = [
	"auth",
	"config",
	"contracts",
	"db",
	"events",
	"observability",
	"ui",
].map((name) => ({
	find: `@portikus/${name}`,
	replacement: new URL(`./packages/${name}/src/index.ts`, import.meta.url).pathname,
}));

// Sub-path aliases must come before their parent package alias so that
// Vite's prefix-based matching resolves them first.
workspaceAliases.unshift(
	{
		// The API's full-chain terminal test starts the real workspace agent
		// in-process: apps/api/src/routes/terminal-real-agent.test.ts.
		find: "@portikus/workspace-agent",
		replacement: new URL("./apps/workspace-agent/src/server.ts", import.meta.url)
			.pathname,
	},
	{
		find: "@portikus/auth/testing",
		replacement: new URL("./packages/auth/src/testing/index.ts", import.meta.url)
			.pathname,
	},
	{
		find: "@portikus/observability/testing",
		replacement: new URL("./packages/observability/src/testing.ts", import.meta.url)
			.pathname,
	},
	{
		find: "@portikus/db/testing",
		replacement: new URL("./packages/db/src/testing.ts", import.meta.url).pathname,
	},
);

/**
 * The test files that talk to the shared PostgreSQL test database. They
 * truncate tables between tests, so they run one file at a time, in the
 * "node-db" project. Everything else runs in parallel in "node".
 *
 * A new test file belongs here if it imports `@portikus/db/testing`,
 * `createTestDb`, or `apps/api/src/test-support.ts`, or reads
 * TEST_DATABASE_URL. Otherwise leave it out and it runs in parallel; if it
 * needs a private resource, give that resource a name of its own (the
 * real-tmux tests each use their own tmux socket name, so they are safe to
 * run side by side).
 */
const databaseTestFiles = [
	"apps/api/src/log-level.test.ts",
	"apps/api/src/routes/admin.test.ts",
	"apps/api/src/routes/auth.test.ts",
	"apps/api/src/routes/files.test.ts",
	"apps/api/src/routes/git-search.test.ts",
	"apps/api/src/routes/hardening.test.ts",
	"apps/api/src/routes/me.test.ts",
	"apps/api/src/routes/project-events.test.ts",
	"apps/api/src/routes/projects.test.ts",
	"apps/api/src/routes/terminal-real-agent.test.ts",
	"apps/api/src/routes/terminal-ws.test.ts",
	"apps/api/src/routes/terminals.test.ts",
	"apps/api/src/routes/workspaces.test.ts",
	"apps/api/src/routes/ws-isolation.test.ts",
	"apps/api/src/routes/ws.test.ts",
	"apps/api/src/server.test.ts",
	"apps/worker/src/log-level.test.ts",
	"apps/worker/src/reconcile.test.ts",
	"apps/worker/src/seed.test.ts",
	"packages/auth/src/plugin.integration.test.ts",
	"packages/auth/src/sessions.test.ts",
	"packages/db/src/db.test.ts",
];

export default defineConfig({
	// Tests import workspace packages from source so `pnpm test` works on a
	// clean checkout, before anything has been built.
	resolve: { alias: workspaceAliases },
	test: {
		// Coverage sits here and not on each project: with `projects`, Vitest
		// only reads the root coverage options.
		coverage: {
			provider: "v8",
			reporter: ["text-summary", "lcov"],
			reportsDirectory: "coverage",
			include: ["apps/*/src/**", "packages/*/src/**"],
			exclude: [
				"**/*.test.*",
				"**/*.d.ts",
				// Test doubles and fixtures.
				"apps/api/src/fake-agent.ts",
				"apps/api/src/test-support.ts",
				"apps/worker/src/fake-controller.ts",
				"apps/workspace-controller/src/fake-provider.ts",
				"packages/db/src/testing.ts",
				"packages/observability/src/testing.ts",
				"packages/ui/src/test-setup.ts",
				// One-shot scripts and process entrypoints, covered by the
				// smoke test and the Playwright suite instead.
				"packages/db/src/migrations/**",
				"packages/db/src/migrate.ts",
				"apps/web/src/main.tsx",
				"apps/api/src/index.ts",
				"apps/worker/src/index.ts",
				"apps/workspace-agent/src/index.ts",
				"apps/workspace-controller/src/index.ts",
				"packages/auth/src/testing/mock-oidc-main.ts",
				// Monaco worker and theme glue; only the browser exercises it.
				"apps/web/src/editor/monaco.ts",
			],
			thresholds: {
				lines: 80,
				branches: 70,
				"apps/api/src/**": { lines: 85 },
				"apps/workspace-agent/src/**": { lines: 85 },
			},
		},
		projects: [
			{
				extends: true,
				test: {
					name: "node",
					environment: "node",
					include: [
						"packages/*/src/**/*.test.ts",
						"apps/api/src/**/*.test.ts",
						"apps/worker/src/**/*.test.ts",
						"apps/workspace-agent/src/**/*.test.ts",
						"apps/workspace-controller/src/**/*.test.ts",
					],
					exclude: [...configDefaults.exclude, ...databaseTestFiles],
				},
			},
			{
				extends: true,
				test: {
					name: "node-db",
					environment: "node",
					// These files share one database and truncate between
					// tests, so they must not run in parallel.
					fileParallelism: false,
					include: databaseTestFiles,
				},
			},
			{
				extends: true,
				plugins: [react()],
				test: {
					name: "web",
					environment: "jsdom",
					setupFiles: ["./packages/ui/src/test-setup.ts"],
					include: ["apps/web/src/**/*.test.ts", "apps/web/src/**/*.test.tsx"],
				},
			},
			{
				extends: true,
				plugins: [react()],
				test: {
					name: "ui",
					environment: "jsdom",
					setupFiles: ["./packages/ui/src/test-setup.ts"],
					include: ["packages/ui/src/**/*.test.tsx"],
				},
			},
		],
	},
});
