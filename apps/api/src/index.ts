import { createOidcClient } from "@portikus/auth";
import { ApiConfigSchema, loadConfig } from "@portikus/config";
import { createDb } from "@portikus/db";
import { createLogger } from "@portikus/observability";
import { toAuthOptions } from "./auth-options.js";
import { startLogLevelSync } from "./log-level.js";
import { loadLtiDeps } from "./routes/lti.js";
import { buildServer } from "./server.js";

const config = loadConfig(ApiConfigSchema);
const logger = createLogger({
	service: "api",
	level: config.LOG_LEVEL,
	pretty: config.NODE_ENV === "development",
});
const db = createDb(config.DATABASE_URL);
const oidc = createOidcClient(toAuthOptions(config));
const lti = await loadLtiDeps(config);
if (lti) logger.info({ platforms: lti.platforms.length }, "lti enabled");
const app = buildServer({ db, config, logger, oidc, ...(lti ? { lti } : {}) });

// Hooks must be added before listen; the first sweep runs after one
// interval, so starting the sync here costs nothing at startup.
const levelSync = startLogLevelSync({
	db,
	logger,
	envLevel: config.LOG_LEVEL,
	agentPort: config.AGENT_PORT,
});
app.addHook("onClose", async () => {
	levelSync.stop();
});

await app.listen({ port: config.PORT, host: "127.0.0.1" });
logger.info({ port: config.PORT }, "api listening");
