import type { Writable } from "node:stream";
import { LOG_LEVELS, LogLevel } from "@portikus/contracts";
import pino from "pino";

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
 * Keys and header names never written to a log line (SPEC.md §24.8, §24.11;
 * BROWSER-HANDLING.md §21.3). Query, fragment, and userinfo are the URL
 * parts that can carry a token. The two key names are institutional
 * credentials and must not appear even outside `institutionalEnv`.
 *
 * This is a backstop two to three levels deep, not a guarantee: log named
 * fields, never a whole database row, config object or request object.
 */
const REDACT_PATHS = [
	"headers.authorization",
	"headers.cookie",
	"req.headers.authorization",
	"req.headers.cookie",
	"*.headers.authorization",
	"*.headers.cookie",
	"*.token",
	"*.agent_token",
	"*.agentToken",
	"*.clientSecret",
	"*.cookie",
	"*.*.token",
	"*.*.agent_token",
	"*.*.agentToken",
	"*.*.clientSecret",
	"*.*.headers.authorization",
	"*.*.headers.cookie",
	"token",
	"agent_token",
	"agentToken",
	"clientSecret",
	"cookie",
	"query",
	"*.query",
	"*.*.query",
	"fragment",
	"*.fragment",
	"*.*.fragment",
	"userinfo",
	"*.userinfo",
	"*.*.userinfo",
	"institutionalEnv",
	"*.institutionalEnv",
	"*.*.institutionalEnv",
	"ANTHROPIC_API_KEY",
	"*.ANTHROPIC_API_KEY",
	"*.*.ANTHROPIC_API_KEY",
	"OPENAI_API_KEY",
	"*.OPENAI_API_KEY",
	"*.*.OPENAI_API_KEY",
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
