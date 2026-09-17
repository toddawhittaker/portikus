import { AgentConfigSchema, loadConfig } from "@portikus/config";
import { log } from "./log.js";
import { buildServer } from "./server.js";

const config = loadConfig(AgentConfigSchema);

const app = buildServer({
	tokenPath: config.TOKEN_PATH,
	homeDir: config.HOME_DIR,
	tmuxSocketName: config.TMUX_SOCKET_NAME,
});

// The workspace bridge is the only network the container has, and the Incus
// ACL allows tcp/7400 from the gateway only (ADR 0009).
app.listen({ host: "0.0.0.0", port: config.PORT }, (err, address) => {
	if (err) {
		log("error", { msg: "workspace-agent failed to listen", error: err.message });
		process.exit(1);
	}
	log("info", { msg: "workspace-agent listening", address, homeDir: config.HOME_DIR });
});
