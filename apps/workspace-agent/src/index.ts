import { AgentConfigSchema, loadConfig } from "@portikus/config";
import { createLogger } from "@portikus/observability";
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

// A restore cut off by a crash leaves its staging and aside directories.
const leftovers = await removeRestoreLeftovers(config.HOME_DIR);
if (leftovers > 0) {
	logger.info({ count: leftovers }, "removed leftover restore directories");
}

const workspaceFromEnv = process.env.PORTIKUS_WORKSPACE_ID ?? "";
const workspaceId =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
		workspaceFromEnv,
	)
		? workspaceFromEnv
		: undefined;

const app = buildServer({
	tokenPath: config.TOKEN_PATH,
	homeDir: config.HOME_DIR,
	recoveryRoot: config.RECOVERY_ROOT,
	tmuxSocketName: config.TMUX_SOCKET_NAME,
	logger,
	brokerSocketPath: "/run/portikus/browser.sock",
	workspaceId,
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
