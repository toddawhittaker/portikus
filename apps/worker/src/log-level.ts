import { LogLevel } from "@portikus/contracts";
import type { Database } from "@portikus/db";
import { applyLevel, errorMessage, type Logger } from "@portikus/observability";
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
 * one that pushes. It pushes the override itself, not its own effective
 * level, so clearing the override sends the controller back to its own
 * environment level. A failed push is logged at debug and retried on the next
 * tick.
 */
export function createLogLevelSync(options: LogLevelSyncOptions): () => Promise<void> {
	const { db, logger, envLevel, controller } = options;
	// Undefined means nothing has been pushed yet; null is a real value.
	let pushed: LogLevel | null | undefined;

	return async function tick(): Promise<void> {
		try {
			const row = await db
				.selectFrom("settings")
				.select("log_level")
				.where("id", "=", 1)
				.executeTakeFirst();
			const parsed = LogLevel.safeParse(row?.log_level);
			const override = parsed.success ? parsed.data : null;
			applyLevel(logger, envLevel, override);
			if (pushed === undefined || pushed !== override) {
				try {
					await controller.setLogLevel(override);
					pushed = override;
				} catch (e) {
					logger.debug(
						{ error: errorMessage(e) },
						"could not set the controller log level",
					);
				}
			}
		} catch (e) {
			logger.warn({ error: errorMessage(e) }, "log level sync failed");
		}
	};
}
