import type { Writable } from "node:stream";
import { LOG_LEVELS, LogLevel } from "@portikus/contracts";
import pino from "pino";
import { SENSITIVE_KEYS } from "./redact.js";

// Contracts owns the level list (STACK.md §15); re-exported here so a
// service that only imports the logger still has the type.
export { LOG_LEVELS, LogLevel };

export type Logger = pino.Logger;

export interface CreateLoggerOptions {
	/** Service name written on every line, for example "api". */
	service: string;
	level: LogLevel;
	/** Human-readable output through pino-pretty; development only. */
	pretty?: boolean;
	/** Test seam: collect lines instead of writing to stdout. */
	destination?: Writable | pino.DestinationStream;
}

/**
 * pino's redaction paths, built from the one key list the Logs tab also
 * uses. This is a backstop two to three levels deep, not a guarantee: log
 * named fields, never a whole database row, config object or request object.
 */
export const REDACT_PATHS: readonly string[] = [
	...SENSITIVE_KEYS.flatMap((key) => [key, `*.${key}`, `*.*.${key}`]),
	"*.*.headers.authorization",
	"*.*.headers.cookie",
];

/**
 * Build the process's one root logger.
 *
 * Keep exactly one root logger per process and do not hold on to child
 * loggers: the runtime level switch sets `logger.level` on the root, and a
 * child copies the level it was created with. Fastify makes a fresh child
 * per request, so request logging follows the switch.
 */
export function createLogger(options: CreateLoggerOptions): Logger {
	const base: pino.LoggerOptions = {
		level: options.level,
		base: { service: options.service },
		timestamp: pino.stdTimeFunctions.isoTime,
		formatters: { level: (label) => ({ level: label }) },
		redact: { paths: [...REDACT_PATHS], censor: "[redacted]" },
	};
	if (options.pretty) {
		return pino({ ...base, transport: { target: "pino-pretty" } });
	}
	if (options.destination) {
		return pino(base, options.destination as pino.DestinationStream);
	}
	return pino(base);
}

/** A logger that writes nothing, for tests. */
export function silentLogger(): Logger {
	return pino({ level: "silent", enabled: false });
}
