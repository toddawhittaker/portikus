import {
	AGENT_LOG_LEVELS,
	AGENT_LOG_MAX_BYTES,
	AGENT_LOG_MAX_LINES,
	type AgentLogLine,
} from "@portikus/contracts";

const KEPT_LEVELS: ReadonlySet<string> = new Set(AGENT_LOG_LEVELS);

/**
 * The agent's last warnings and errors, in memory only, for the admin
 * workspace page (ADR 0060). Only allowlisted fields are kept, so paths,
 * project names and anything else logged beside a message never leave here.
 */
export class LogRing {
	private readonly entries: { line: AgentLogLine; bytes: number }[] = [];
	private totalBytes = 0;

	constructor(
		private readonly maxLines = AGENT_LOG_MAX_LINES,
		private readonly maxBytes = AGENT_LOG_MAX_BYTES,
	) {}

	/** Take one pino JSON line; anything else is ignored. */
	push(raw: string): void {
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			return;
		}
		const line = pick(parsed);
		if (!line) return;
		const bytes = Buffer.byteLength(JSON.stringify(line));
		if (bytes > this.maxBytes) return;
		this.entries.push({ line, bytes });
		this.totalBytes += bytes;
		while (this.entries.length > this.maxLines || this.totalBytes > this.maxBytes) {
			const dropped = this.entries.shift();
			if (dropped) this.totalBytes -= dropped.bytes;
		}
	}

	/** The kept lines, oldest first. */
	lines(): AgentLogLine[] {
		return this.entries.map((entry) => entry.line);
	}
}

/** The allowlisted fields of a kept-level line, or null. */
function pick(value: unknown): AgentLogLine | null {
	if (value === null || typeof value !== "object") return null;
	const { time, level, msg, code, status, durationMs } = value as Record<
		string,
		unknown
	>;
	if (typeof level !== "string" || !KEPT_LEVELS.has(level)) return null;
	if (typeof time !== "string" || typeof msg !== "string") return null;
	const line: AgentLogLine = { time, level: level as AgentLogLine["level"], msg };
	if (typeof code === "string") line.code = code;
	if (typeof status === "number" && Number.isInteger(status)) line.status = status;
	if (typeof durationMs === "number" && Number.isFinite(durationMs)) {
		line.durationMs = durationMs;
	}
	return line;
}

/**
 * A logger destination that passes every line on and copies it into the
 * ring. It writes synchronously, as pino's default destination does.
 */
export function teeToRing(
	ring: LogRing,
	out: NodeJS.WritableStream,
): { write(text: string): void } {
	return {
		write(text: string) {
			for (const part of text.split("\n")) {
				if (part !== "") ring.push(part);
			}
			out.write(text);
		},
	};
}
