import { spawn } from "node:child_process";
import { createRunDatabase, dropRunDatabase } from "../packages/db/dist/testing.js";

/**
 * Create this run's database before Playwright starts, and drop it only
 * after Playwright has exited. Creating it inside playwright.config.ts runs
 * more than once, and the second run drops the database the API is still
 * connected to.
 */
const sharedUrl =
	process.env.TEST_DATABASE_URL ??
	"postgres://postgres:portikus@127.0.0.1:55432/portikus_test";

const created = await createRunDatabase(sharedUrl);
const child = spawn("pnpm", ["exec", "playwright", "test", ...process.argv.slice(2)], {
	stdio: "inherit",
	env: {
		...process.env,
		TEST_DATABASE_URL: created.url,
		PORTIKUS_E2E_ADMIN_URL: sharedUrl,
		PORTIKUS_E2E_DB_NAME: created.name,
	},
});

const code = await new Promise((resolve) => {
	child.on("exit", (status) => resolve(status ?? 1));
});

await dropRunDatabase(sharedUrl, created.name);
process.exit(code);
