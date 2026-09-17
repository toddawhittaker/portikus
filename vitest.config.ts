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
					include: ["apps/web/src/**/*.test.tsx"],
				},
			},
			{
				extends: true,
				plugins: [react()],
				test: {
					name: "ui",
					environment: "jsdom",
					include: ["packages/ui/src/**/*.test.tsx"],
				},
			},
		],
	},
});
