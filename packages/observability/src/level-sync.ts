import type { Logger, LogLevel } from "./logger.js";

/**
 * Point the root logger at the effective level: the runtime override when one
 * is set, otherwise the level from the environment. Logs once per change and
 * returns the level now in force.
 */
export function applyLevel(
	logger: Logger,
	envLevel: LogLevel,
	override: LogLevel | null,
): LogLevel {
	const effective = override ?? envLevel;
	if (logger.level !== effective) {
		const from = logger.level;
		logger.level = effective;
		logger.info(
			{ from, to: effective, source: override ? "settings" : "environment" },
			"log level changed",
		);
	}
	return effective;
}
