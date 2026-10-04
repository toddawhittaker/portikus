import type { LogLevel, LogService } from "@portikus/contracts";

export const LEVEL_LABELS: Record<LogLevel, string> = {
	error: "Error",
	warn: "Warn",
	info: "Info",
	debug: "Debug",
};

export const SERVICE_LABELS: Record<LogService, string> = {
	api: "API",
	worker: "Worker",
	controller: "Controller",
	network: "Network",
};

/** The level as a word, so the tag never relies on colour. */
export function levelText(level: string): string {
	if (level === "fatal") return "Fatal";
	return LEVEL_LABELS[level as LogLevel] ?? level;
}

export function levelTagClass(level: string): string {
	if (level === "error" || level === "fatal") return "pk-tag pk-tag--error";
	if (level === "warn") return "pk-tag pk-tag--warning";
	return "pk-tag";
}

/** One field of a JSON log line as text; empty when it is missing. */
export function field(line: Record<string, unknown>, name: string): string {
	const value = line[name];
	if (value === undefined || value === null) return "";
	return typeof value === "string" ? value : JSON.stringify(value);
}

/** The row's message: the error when there is one, else `msg`. */
export function messageOf(line: Record<string, unknown>): string {
	return field(line, "error") || field(line, "msg");
}
