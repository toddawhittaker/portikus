import {
	LOG_PAGE_SIZE,
	type LogLevel,
	type LogQuery,
	type LogService,
} from "@portikus/contracts";
import { redactLine } from "@portikus/observability";
import type { JournalReader } from "./journal.js";

export type PortikusLine = Record<string, unknown> & {
	level: string;
	service: string;
	time: string;
};

/**
 * The MESSAGE as a Portikus JSON line: an object with a string `level`,
 * `service` and `time`. Anything else (systemd's own lines, raw stack
 * traces) is null and not shown (docs/adr/0036).
 */
export function parsePortikusLine(message: string | null): PortikusLine | null {
	if (message === null) return null;
	let value: unknown;
	try {
		value = JSON.parse(message);
	} catch {
		return null;
	}
	if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
	const line = value as Record<string, unknown>;
	if (
		typeof line.level !== "string" ||
		typeof line.service !== "string" ||
		typeof line.time !== "string"
	) {
		return null;
	}
	return line as PortikusLine;
}

/** The filter level a line belongs to; fatal is shown as an error. */
export function levelOf(level: string): LogLevel | null {
	switch (level) {
		case "fatal":
		case "error":
			return "error";
		case "warn":
			return "warn";
		case "info":
			return "info";
		case "debug":
		case "trace":
			return "debug";
		default:
			return null;
	}
}

function asText(value: unknown): string {
	if (value === undefined || value === null) return "";
	return typeof value === "string" ? value : JSON.stringify(value);
}

export interface LineFilter {
	levels: readonly LogLevel[];
	services?: readonly LogService[];
	text?: string;
	userId?: string;
	workspaceId?: string;
	/** The workspace's Incus instance, which the controller logs as `instance`. */
	instanceName?: string | null;
}

/** Whether a (redacted) line passes the filters the API applies after parsing. */
export function matchesLine(
	line: PortikusLine,
	service: LogService,
	filter: LineFilter,
): boolean {
	const level = levelOf(line.level);
	if (!level || !filter.levels.includes(level)) return false;
	if (filter.services && !filter.services.includes(service)) return false;
	if (filter.userId !== undefined && line.userId !== filter.userId) return false;
	if (filter.workspaceId !== undefined) {
		const byId = line.workspaceId === filter.workspaceId;
		const byInstance =
			service === "controller" &&
			typeof filter.instanceName === "string" &&
			line.instance === filter.instanceName;
		if (!byId && !byInstance) return false;
	}
	if (filter.text !== undefined) {
		const needle = filter.text.toLowerCase();
		const haystack = [line.code, line.msg, line.error].map(asText).join("\n");
		if (!haystack.toLowerCase().includes(needle)) return false;
	}
	return true;
}

export interface FoundLine {
	cursor: string;
	at: Date;
	service: LogService;
	line: PortikusLine;
}

export interface FoundPage {
	lines: FoundLine[];
	nextCursor: string | null;
	scanComplete: boolean;
	skippedLines: number;
}

/** Read one page, newest first, redacting each line before it is filtered or kept. */
export async function readLogPage(
	reader: JournalReader,
	query: LogQuery,
	instanceName: string | null,
): Promise<FoundPage> {
	const filter: LineFilter = {
		levels: query.level,
		...(query.service ? { services: query.service } : {}),
		...(query.q !== undefined ? { text: query.q } : {}),
		...(query.user !== undefined ? { userId: query.user } : {}),
		...(query.workspace !== undefined
			? { workspaceId: query.workspace, instanceName }
			: {}),
	};
	const lines: FoundLine[] = [];
	let skippedLines = 0;
	const result = await reader.read(
		{
			reverse: true,
			levels: query.level,
			...(query.since ? { since: new Date(query.since) } : {}),
			...(query.until ? { until: new Date(query.until) } : {}),
			...(query.cursor ? { afterCursor: query.cursor } : {}),
		},
		(entry) => {
			const parsed = parsePortikusLine(entry.message);
			if (!parsed) {
				skippedLines++;
				return "continue";
			}
			const line = redactLine(parsed) as PortikusLine;
			if (!matchesLine(line, entry.service, filter)) return "continue";
			lines.push({ cursor: entry.cursor, at: entry.at, service: entry.service, line });
			return lines.length >= LOG_PAGE_SIZE ? "stop" : "continue";
		},
	);
	return {
		lines,
		nextCursor: result.reason === "end" ? null : result.lastCursor,
		scanComplete: result.reason !== "limit",
		skippedLines,
	};
}
