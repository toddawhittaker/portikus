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
		const line = { from, to: effective, source: override ? "settings" : "environment" };
		// Pino's numbers rise as levels get quieter, so a bigger number for the
		// new level means we are about to log less. Announce that while the old,
		// louder level is still in force; announce a raise once it is in force.
		const quieter =
			(logger.levels.values[effective] ?? 0) > (logger.levels.values[from] ?? 0);
		if (quieter) logger.info(line, "log level changed");
		logger.level = effective;
		if (!quieter) logger.info(line, "log level changed");
	}
	return effective;
}
