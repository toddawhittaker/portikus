import type { LogLevel, LogService } from "@portikus/contracts";
import type { BadgeTone } from "@portikus/ui";

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

/** Error and Warn take the status colours; Info and Debug stay neutral, so problems stand out. */
export function levelTone(level: string): BadgeTone {
	if (level === "error" || level === "fatal") return "danger";
	if (level === "warn") return "warning";
	return "neutral";
}

/** A 5xx response reads as an error and a 4xx as a warning; the rest stay plain. */
export function statusClass(status: string): string | undefined {
	if (/^5\d\d$/.test(status)) return "text-status-error";
	if (/^4\d\d$/.test(status)) return "text-status-warning";
	return undefined;
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

/** The time of day with seconds, for a column of log lines. */
export function clockTime(iso: string): string {
	return new Date(iso).toLocaleTimeString(undefined, {
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	});
}

/** "Nov 11" for a line from another day; empty for today, which the time alone says. */
export function dayLabel(iso: string, now: Date = new Date()): string {
	const at = new Date(iso);
	if (at.toDateString() === now.toDateString()) return "";
	return at.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
