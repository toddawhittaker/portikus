import { ControllerConfigSchema, loadConfig } from "@portikus/config";
import { IncusClient } from "./incus.js";
import { IncusWorkspaceProvider } from "./provider.js";
import { buildServer } from "./server.js";

const config = loadConfig(ControllerConfigSchema);
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
});

const app = buildServer({
	provider,
	token: config.CONTROLLER_TOKEN,
});

app.listen({ host: "127.0.0.1", port: config.PORT }, (err, address) => {
	if (err) {
		app.log.error(err);
		process.exit(1);
	}
	console.log(`workspace-controller listening on ${address}`);
});
