import { Writable } from "node:stream";
import { createLogger, type Logger, type LogLevel } from "./logger.js";

/** A logger whose lines are collected in memory, for assertions in tests. */
export function collectingLogger(level: LogLevel = "info"): {
	logger: Logger;
	lines: Record<string, unknown>[];
} {
	const lines: Record<string, unknown>[] = [];
	const destination = new Writable({
		write(chunk, _encoding, callback) {
			for (const text of String(chunk).split("\n")) {
				if (text.trim() !== "") lines.push(JSON.parse(text));
			}
			callback();
		},
	});
	return { logger: createLogger({ service: "test", level, destination }), lines };
}

/** The line at `index`, or a clear failure if the logger wrote fewer. */
export function lineAt(
	lines: Record<string, unknown>[],
	index: number,
): Record<string, unknown> {
	const line = lines[index];
	if (!line) throw new Error(`no log line at index ${index}; got ${lines.length}`);
	return line;
}
