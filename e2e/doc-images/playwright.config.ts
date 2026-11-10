import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";
import main from "../../playwright.config";

/**
 * `make screenshots`: the documentation images in docs/images, taken from the
 * end-to-end stack the main config starts (its fakes and its servers), on a
 * private database made by e2e/with-run-database.mjs. The files are named
 * `*.capture.ts`, so the main runs and CI never pick them up.
 */
const root = join(import.meta.dirname, "../..");

export default defineConfig({
	...main,
	testDir: import.meta.dirname,
	testMatch: /\.capture\.ts$/,
	fullyParallel: false,
	workers: 1,
	retries: 0,
	timeout: 60_000,
	projects: [
		// The main suite's setup: it makes the settings row and the mock invitations.
		{
			name: "setup",
			testDir: join(root, "e2e"),
			testMatch: /environment\.setup\.ts$/,
		},
		{
			name: "screenshots",
			dependencies: ["setup"],
			use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
		},
	],
	webServer: (Array.isArray(main.webServer) ? main.webServer : []).map((server) => ({
		...server,
		cwd: root,
		reuseExistingServer: false,
	})),
});
