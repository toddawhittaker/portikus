import { ControllerConfigSchema, loadConfig } from "@portikus/config";
import { createLogger } from "@portikus/observability";
import { IncusClient } from "./incus.js";
import { IncusWorkspaceProvider } from "./provider.js";
import { buildServer } from "./server.js";

const config = loadConfig(ControllerConfigSchema);
const logger = createLogger({
	service: "workspace-controller",
	level: config.LOG_LEVEL,
	pretty: config.NODE_ENV === "development",
});
const client = new IncusClient({
	socketPath: config.INCUS_SOCKET,
	project: config.INCUS_PROJECT,
});
const provider = new IncusWorkspaceProvider({
	client,
	pool: config.INCUS_POOL,
	profile: config.INCUS_PROFILE,
	imageAlias: config.INCUS_IMAGE_ALIAS,
	agentPort: config.AGENT_PORT,
	logger,
});

const app = buildServer({
	provider,
	token: config.CONTROLLER_TOKEN,
	logger,
});

app.listen({ host: "127.0.0.1", port: config.PORT }, (err, address) => {
	if (err) {
		logger.error({ error: err.message }, "workspace-controller failed to listen");
		process.exit(1);
	}
	logger.info({ address }, "workspace-controller listening");
});
