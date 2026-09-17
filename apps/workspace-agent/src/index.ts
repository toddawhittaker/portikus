import { AgentConfigSchema, loadConfig } from "@portikus/config";
import { createLogger } from "@portikus/observability";
import { removeStaleTemporaries } from "./projects.js";
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

const app = buildServer({
	tokenPath: config.TOKEN_PATH,
	homeDir: config.HOME_DIR,
	tmuxSocketName: config.TMUX_SOCKET_NAME,
	logger,
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
