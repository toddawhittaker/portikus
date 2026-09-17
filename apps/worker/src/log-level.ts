import type { Database } from "@portikus/db";
import { applyLevel, type Logger, type LogLevel } from "@portikus/observability";
import type { Kysely } from "kysely";
import type { ControllerClient } from "./controller-client.js";

export interface LogLevelSyncOptions {
	db: Kysely<Database>;
	logger: Logger;
	/** The level from the environment, used when no override is set. */
	envLevel: LogLevel;
	controller: ControllerClient;
}

/**
 * Build the tick that keeps the process at the log level an administrator
 * chose and relays that level to the controller (ADR 0012).
 *
 * The worker is the only service with controller credentials, so it is the
 * one that pushes. A failed push is logged at debug and retried on the next
 * tick, and a tick is skipped while the previous one is still running.
 */
export function createLogLevelSync(options: LogLevelSyncOptions): () => Promise<void> {
	const { db, logger, envLevel, controller } = options;
	let pushed: LogLevel | null = null;
	let inFlight = false;

	return async function tick(): Promise<void> {
		if (inFlight) return;
		inFlight = true;
		try {
			const row = await db
				.selectFrom("settings")
				.select("log_level")
				.where("id", "=", 1)
				.executeTakeFirst();
			const override = (row?.log_level ?? null) as LogLevel | null;
			const effective = applyLevel(logger, envLevel, override);
			if (effective !== pushed) {
				await controller.setLogLevel(effective);
				pushed = effective;
			}
		} catch (e) {
			logger.debug(
				{ error: e instanceof Error ? e.message : String(e) },
				"log level sync failed",
			);
		} finally {
			inFlight = false;
		}
	};
}
