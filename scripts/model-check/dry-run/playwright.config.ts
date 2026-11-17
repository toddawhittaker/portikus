import { join } from "node:path";
import { defineConfig } from "@playwright/test";
import main from "../../../playwright.config";

/**
 * `make model-check DRY_RUN=1`: the model check's harness run against the
 * end-to-end stack the main config starts, with its fake model, on a private
 * database made by e2e/with-run-database.mjs. The file is named
 * `*.dryrun.ts`, so the main runs and CI never pick it up.
 */
const root = join(import.meta.dirname, "../../..");

export default defineConfig({
	...main,
	testDir: import.meta.dirname,
	testMatch: /\.dryrun\.ts$/,
	fullyParallel: false,
	workers: 1,
	retries: 0,
	timeout: 900_000,
	projects: [
		// The main suite's setup: it makes the settings row.
		{
			name: "setup",
			testDir: join(root, "e2e"),
			testMatch: /environment\.setup\.ts$/,
		},
		{ name: "model-check", dependencies: ["setup"] },
	],
	webServer: (Array.isArray(main.webServer) ? main.webServer : []).map((server) => ({
		...server,
		cwd: root,
		reuseExistingServer: false,
	})),
});
