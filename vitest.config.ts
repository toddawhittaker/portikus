import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Sub-path aliases must come before their parent package alias so Vite
// matches the more specific path first.
const workspaceAliases: { find: string; replacement: string }[] = [
	{
		find: "@portikus/db/testing",
		replacement: new URL("./packages/db/src/testing.ts", import.meta.url).pathname,
	},
];

for (const name of [
	"auth",
	"config",
	"contracts",
	"db",
	"events",
	"observability",
	"ui",
]) {
	workspaceAliases.push({
		find: `@portikus/${name}`,
		replacement: new URL(`./packages/${name}/src/index.ts`, import.meta.url).pathname,
	});
}

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
