import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

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
		find: "@portikus/db/testing",
		replacement: new URL("./packages/db/src/testing.ts", import.meta.url).pathname,
	},
);

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
				"packages/observability/src/test-support.ts",
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
					// DB test files share one database and truncate between
					// tests, so they must not run in parallel.
					fileParallelism: false,
					include: [
						"packages/*/src/**/*.test.ts",
						"apps/api/src/**/*.test.ts",
						"apps/worker/src/**/*.test.ts",
						"apps/workspace-agent/src/**/*.test.ts",
						"apps/workspace-controller/src/**/*.test.ts",
					],
				},
			},
			{
				extends: true,
				plugins: [react()],
				test: {
					name: "web",
					environment: "jsdom",
					setupFiles: ["./packages/ui/src/test-setup.ts"],
					include: ["apps/web/src/**/*.test.tsx"],
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
