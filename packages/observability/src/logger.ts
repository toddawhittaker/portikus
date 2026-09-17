import type { Writable } from "node:stream";
import pino from "pino";

/** The log levels Portikus uses, loudest first (STACK.md §15). */
export const LOG_LEVELS = ["error", "warn", "info", "debug"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

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
 * Keys and header names never written to a log line (SPEC.md §24.11).
 */
const REDACT_PATHS = [
	"headers.authorization",
	"headers.cookie",
	"req.headers.authorization",
	"req.headers.cookie",
	"*.headers.authorization",
	"*.headers.cookie",
	"*.token",
	"*.agentToken",
	"*.clientSecret",
	"token",
	"agentToken",
	"clientSecret",
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
		redact: { paths: REDACT_PATHS, censor: "[redacted]" },
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
