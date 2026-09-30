import { stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { AgentConfigSchema, loadConfig } from "@portikus/config";
import { createLogger } from "@portikus/observability";
import { seedAgentInstructions } from "./agent-instructions.js";
import { removeStaleTemporaries } from "./projects.js";
import { removeRestoreLeftovers } from "./recovery.js";
import { buildServer } from "./server.js";

const config = loadConfig(AgentConfigSchema);
const logger = createLogger({
	service: "workspace-agent",
	level: config.LOG_LEVEL,
	pretty: config.NODE_ENV === "development",
});

// A workspace stopped mid-clone leaves a half-finished directory behind.
for (const name of await removeStaleTemporaries(config.HOME_DIR)) {
	logger.info({ name }, "removed a stale project temporary directory");
}

// A restore cut off by a crash leaves its staging directory. An aside
// directory may hold the only copy of files, so it is kept.
const leftovers = await removeRestoreLeftovers(config.HOME_DIR);
if (leftovers > 0) {
	logger.info({ count: leftovers }, "removed leftover restore directories");
}

// Missing instruction files must never stop the agent from serving.
try {
	for (const file of await seedAgentInstructions(config.HOME_DIR)) {
		logger.info({ file }, "created a coding-agent instructions file");
	}
} catch (error) {
	logger.warn(
		{ error: (error as Error).message },
		"could not create the coding-agent instructions files",
	);
}

const workspaceFromEnv = process.env.PORTIKUS_WORKSPACE_ID ?? "";
const workspaceId =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
		workspaceFromEnv,
	)
		? workspaceFromEnv
		: undefined;

// The package's own change time (ctime, as the controller compares) names the agent code; an upgrade changes it (issue #887).
const build = await stat(fileURLToPath(import.meta.url)).then(
	(file) => file.ctime.toISOString(),
	() => undefined,
);

const app = buildServer({
	tokenPath: config.TOKEN_PATH,
	homeDir: config.HOME_DIR,
	recoveryRoot: config.RECOVERY_ROOT,
	tmuxSocketName: config.TMUX_SOCKET_NAME,
	tmuxExternalServer: config.TMUX_EXTERNAL_SERVER,
	logger,
	brokerSocketPath: "/run/portikus/browser.sock",
	workspaceId,
	build,
});

// The workspace bridge is the only network the container has, and the Incus
// ACL allows tcp/7400 from the gateway only (ADR 0009).
app.listen({ host: "0.0.0.0", port: config.PORT }, (err, address) => {
	if (err) {
		logger.error({ error: err.message }, "workspace-agent failed to listen");
		process.exit(1);
	}
	logger.info({ address, homeDir: config.HOME_DIR }, "workspace-agent listening");
});
