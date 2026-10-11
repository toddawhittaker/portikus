import { loadConfig, WorkerConfigSchema } from "@portikus/config";
import { createDb, type Database } from "@portikus/db";
import { createLogger, errorMessage, readAlertChannels } from "@portikus/observability";
import type { Kysely } from "kysely";
import { httpAgentFactory } from "./agent-client.js";
import { startAgentUsage } from "./agent-usage.js";
import { startAlertSources } from "./alert-sources.js";
import { startAlertForwarding } from "./alerts.js";
import { startBackupVmLoop } from "./backups.js";
import { HttpControllerClient } from "./controller-client.js";
import { startSeedJobs } from "./docker-seed-jobs.js";
import { startDockerUsage } from "./docker-usage.js";
import { startEgressSync } from "./egress.js";
import { startBlockedCounter } from "./egress-blocked.js";
import { startGuard } from "./guard.js";
import { startHealthSampling } from "./health.js";
import { startLimitsSync } from "./limits.js";
import { createLogLevelSync } from "./log-level.js";
import { startLoop, startSweepLoop } from "./loop.js";
import { startNotificationPrune } from "./notifications.js";
import { startPackageSurvey } from "./package-survey.js";
import { startProcessSnapshots } from "./process-snapshots.js";
import { startQuotaSync } from "./quota.js";
import { reconcile, type SweepResult } from "./reconcile.js";
import { recoverySweep } from "./recovery.js";
import { startRegistryEvents } from "./registry-events.js";
import { startTerminalPrune } from "./terminal-prune.js";

export const serviceName = "worker";

export function describeService(): string {
	return `portikus ${serviceName}`;
}

/**
 * Put the platform-wide grace period in the database the first time the
 * worker runs (SPEC.md §6.4). Later starts leave the administrator's value
 * alone. Returns true when this call inserted the row.
 */
export async function seedSettings(
	db: Kysely<Database>,
	graceSeconds: number,
): Promise<boolean> {
	const result = await db
		.insertInto("settings")
		.values({ id: 1, shutdown_grace_seconds: graceSeconds })
		.onConflict((oc) => oc.doNothing())
		.executeTakeFirst();
	return Number(result?.numInsertedOrUpdatedRows ?? 0n) > 0;
}

/** How often the worker re-reads the log level an administrator chose. */
const LOG_LEVEL_SYNC_SECONDS = 5;

/** Start the reconcile loop; only runs when invoked as main. */
async function main(): Promise<void> {
	const config = loadConfig(WorkerConfigSchema);
	const logger = createLogger({
		service: serviceName,
		level: config.LOG_LEVEL,
		pretty: config.NODE_ENV === "development",
	});
	const db = createDb(config.DATABASE_URL, undefined, (error) =>
		logger.warn({ err: error }, "database connection lost"),
	);
	if (await seedSettings(db, config.SHUTDOWN_GRACE_SECONDS)) {
		logger.info(
			{ shutdownGraceSeconds: config.SHUTDOWN_GRACE_SECONDS },
			"seeded platform settings",
		);
	}

	const controller = new HttpControllerClient(
		config.CONTROLLER_URL,
		config.CONTROLLER_TOKEN,
	);

	logger.info(
		{ sweepInterval: config.SWEEP_INTERVAL_SECONDS },
		`${describeService()} starting`,
	);

	// The log level lives on its own timer, so a slow read never delays a sweep.
	const syncLogLevel = createLogLevelSync({
		db,
		logger,
		envLevel: config.LOG_LEVEL,
		controller,
	});
	startLoop("log level sync", logger, syncLogLevel, LOG_LEVEL_SYNC_SECONDS * 1000);

	// Host samples, quota grows and the resource guard each run on their own timer, off the sweep.
	startHealthSampling({ db, controller, logger });
	startQuotaSync({ db, controller, logger });
	startLimitsSync({ db, controller, logger });
	startGuard({ db, controller, logger });
	startNotificationPrune({ db, logger });
	startAlertSources({ db, logger });
	startAlertForwarding({
		db,
		logger,
		loadChannels: () =>
			readAlertChannels(config.NOTIFY_FILE, config.OUTBOUND_PROXY_URL),
	});
	startTerminalPrune({ db, logger });
	startProcessSnapshots({ db, controller, logger, agentPort: config.AGENT_PORT });
	startBackupVmLoop({ db, controller, logger });
	startEgressSync({ db, controller, logger });
	// Only the egress dnsmasq and the workspace Squid talk to this, on loopback (ADR 0038).
	// If it cannot listen, unlisted names time out instead of NXDOMAIN: still refused.
	startBlockedCounter({ db, logger }).catch((e: Error) =>
		logger.error({ error: e.message }, "blocked-name counter failed to listen"),
	);
	startPackageSurvey({ db, controller, logger });
	// Shared Docker pull storage.
	startSeedJobs({ db, controller, logger });
	startDockerUsage({ db, logger, agentPort: config.AGENT_PORT });
	startAgentUsage({ db, logger, agentPort: config.AGENT_PORT });
	startRegistryEvents({ db, logger, port: config.REGISTRY_EVENTS_PORT }).catch(
		(e: Error) =>
			logger.error({ error: e.message }, "registry events listener failed to listen"),
	);

	let lastRefreshAt: Date | null = null;
	let controllerUnreachable = false;

	const sweep = async (): Promise<void> => {
		try {
			const now = new Date();
			const result: SweepResult = await reconcile(db, controller, config, now, {
				lastRefreshAt,
				controllerUnreachable,
				log: logger,
			});
			lastRefreshAt = result.lastRefreshAt;
			controllerUnreachable = result.controllerUnreachable;
			if (result.refreshError) {
				logger.error(
					{ errorCode: result.refreshError.code },
					"controller status refresh failed",
				);
			}
			if (result.transitions > 0) {
				logger.info({ transitions: result.transitions }, "sweep");
			}
		} catch (e) {
			logger.error({ error: errorMessage(e) }, "sweep error");
		}
	};

	// Recovery points run on their own timer: an archive can take minutes.
	const recovery = async (): Promise<void> => {
		try {
			const result = await recoverySweep(
				db,
				httpAgentFactory(config.AGENT_PORT),
				config,
				new Date(),
				logger,
			);
			if (result.created > 0 || result.deleted > 0) {
				logger.info(result, "recovery sweep");
			}
		} catch (e) {
			logger.error({ error: errorMessage(e) }, "recovery sweep error");
		}
	};

	startSweepLoop(sweep, config.SWEEP_INTERVAL_SECONDS * 1000);
	startSweepLoop(recovery, config.RECOVERY_SWEEP_SECONDS * 1000);
}

if (process.argv[1]?.endsWith("index.ts") || process.argv[1]?.endsWith("index.js")) {
	main().catch((e) => {
		createLogger({ service: serviceName, level: "error" }).error(
			{ err: e },
			"worker failed to start",
		);
		process.exit(1);
	});
}
