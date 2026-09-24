import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { createRunDatabase, dropRunDatabase } from "../packages/db/dist/testing.js";

/**
 * Create this run's database and pick its ports before Playwright starts, and drop it only
 * after Playwright has exited. Creating it inside playwright.config.ts runs
 * more than once, and the second run drops the database the API is still
 * connected to.
 */
const sharedUrl =
	process.env.TEST_DATABASE_URL ??
	"postgres://postgres:portikus@127.0.0.1:55432/portikus_test";

/**
 * Pick `count` free ports by holding them all open at once, so no two are
 * the same, then release them for the servers Playwright starts.
 */
async function freePorts(count) {
	const servers = [];
	for (let made = 0; made < count; made += 1) {
		const server = createServer();
		await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
		servers.push(server);
	}
	const ports = servers.map((server) => server.address().port);
	await Promise.all(
		servers.map((server) => new Promise((resolve) => server.close(resolve))),
	);
	return ports;
}

const [webPort, apiPort, oidcPort, agentPort, mockLmsPort, dexGrpcPort] =
	await freePorts(6);
const created = await createRunDatabase(sharedUrl);
const child = spawn("pnpm", ["exec", "playwright", "test", ...process.argv.slice(2)], {
	stdio: "inherit",
	env: {
		...process.env,
		TEST_DATABASE_URL: created.url,
		PORTIKUS_E2E_ADMIN_URL: sharedUrl,
		PORTIKUS_E2E_DB_NAME: created.name,
		// Read by e2e/ports.ts, playwright.config.ts, and apps/web/vite.config.ts.
		PORTIKUS_WEB_PORT: String(webPort),
		PORTIKUS_API_PORT: String(apiPort),
		PORTIKUS_OIDC_PORT: String(oidcPort),
		FAKE_AGENT_PORT: String(agentPort),
		PORTIKUS_MOCK_LMS_PORT: String(mockLmsPort),
		FAKE_DEX_GRPC_PORT: String(dexGrpcPort),
	},
});

const code = await new Promise((resolve) => {
	child.on("exit", (status) => resolve(status ?? 1));
});

await dropRunDatabase(sharedUrl, created.name);
process.exit(code);
