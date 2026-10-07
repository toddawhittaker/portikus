import { createOidcClient, loadDexApi } from "@portikus/auth";
import { ApiConfigSchema, loadConfig } from "@portikus/config";
import { createDb } from "@portikus/db";
import { createLogger } from "@portikus/observability";
import { startLogAlerts } from "./alerts/log-alerts.js";
import { toAuthOptions } from "./auth-options.js";
import { startCertificateNotices } from "./certificate/notices.js";
import { imagesDirOf, startReleaseNotices } from "./image/release-notices.js";
import { startLogLevelSync } from "./log-level.js";
import { JournalReader } from "./logs/journal.js";
import { loadLtiDeps } from "./lti/deps.js";
import { buildServer } from "./server.js";
import { closeOnSigterm } from "./shutdown.js";

const config = loadConfig(ApiConfigSchema);
const logger = createLogger({
	service: "api",
	level: config.LOG_LEVEL,
	pretty: config.NODE_ENV === "development",
});
const db = createDb(config.DATABASE_URL, undefined, (error) =>
	logger.warn({ err: error }, "database connection lost"),
);
const oidc = createOidcClient(toAuthOptions(config));
const lti = await loadLtiDeps(config);
if (lti) logger.info({ platforms: lti.platforms.length }, "lti enabled");
const dex = await loadDexApi(config);
if (dex) logger.info("dex user management enabled");
const app = buildServer({
	db,
	config,
	logger,
	oidc,
	...(lti ? { lti } : {}),
	...(dex ? { dex } : {}),
});

// Hooks must be added before listen; the first sweep runs after one
// interval, so starting the sync here costs nothing at startup.
const levelSync = startLogLevelSync({
	db,
	logger,
	envLevel: config.LOG_LEVEL,
	agentPort: config.AGENT_PORT,
});
const stopReleaseNotices = config.IMAGE_JOBS_DIR
	? startReleaseNotices({
			db,
			logger,
			imagesDir: imagesDirOf(config.IMAGE_JOBS_DIR),
			intervalSeconds: config.RELEASE_NOTICE_SECONDS,
		})
	: () => {};
const stopCertificateNotices = config.CERTIFICATE_JOBS_DIR
	? startCertificateNotices({
			db,
			logger,
			jobsDir: config.CERTIFICATE_JOBS_DIR,
			intervalSeconds: config.RELEASE_NOTICE_SECONDS,
		})
	: () => {};
const stopLogAlerts = startLogAlerts({
	db,
	logger,
	reader: new JournalReader({ path: config.JOURNALCTL_PATH }),
});
app.addHook("onClose", async () => {
	await stopLogAlerts();
	levelSync.stop();
	stopReleaseNotices();
	stopCertificateNotices();
	dex?.close();
});
closeOnSigterm(app);

await app.listen({ port: config.PORT, host: "127.0.0.1" });
logger.info({ port: config.PORT }, "api listening");
