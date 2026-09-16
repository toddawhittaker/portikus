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
workspaceAliases.unshift({
	find: "@portikus/db/testing",
	replacement: new URL("./packages/db/src/testing.ts", import.meta.url).pathname,
});

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
		],
	},
});
