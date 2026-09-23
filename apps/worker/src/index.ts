import { loadConfig, WorkerConfigSchema } from "@portikus/config";
import { createDb, type Database } from "@portikus/db";
import { createLogger } from "@portikus/observability";
import type { Kysely } from "kysely";
import { HttpControllerClient } from "./controller-client.js";
import { startHealthSampling } from "./health.js";
import { createLogLevelSync } from "./log-level.js";
import { startQuotaSync } from "./quota.js";
import { reconcile, type SweepResult } from "./reconcile.js";

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
	const db = createDb(config.DATABASE_URL);
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
	const logLevelTimer = setInterval(() => {
		void syncLogLevel();
	}, LOG_LEVEL_SYNC_SECONDS * 1000);
	// Do not keep the process alive for this, and leave Node's default signal
	// handling in place so systemd's SIGTERM stops the worker at once.
	logLevelTimer.unref();
	void syncLogLevel();

	// Host samples and quota grows each run on their own timer, off the sweep.
	startHealthSampling({ db, controller, logger });
	startQuotaSync({ db, controller, logger });

	let lastRefreshAt: Date | null = null;
	let controllerUnreachable = false;

	const loop = async (): Promise<void> => {
		try {
			const now = new Date();
			const result: SweepResult = await reconcile(
				db,
				controller,
				config,
				now,
				lastRefreshAt,
				controllerUnreachable,
				logger,
			);
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
			logger.error(
				{ error: e instanceof Error ? e.message : String(e) },
				"sweep error",
			);
		}
		setTimeout(loop, config.SWEEP_INTERVAL_SECONDS * 1000);
	};

	await loop();
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
