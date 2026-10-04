import { spawn as nodeSpawn } from "node:child_process";
import type { Readable } from "node:stream";
import { JOURNAL_CURSOR, type LogLevel, type LogService } from "@portikus/contracts";
import { KERNEL_LINE_PATTERN, kernelLineMessage } from "./kernel.js";

/** The only units the Logs tab reads, and the service each one is (docs/adr/0036). */
const PORTIKUS_UNITS: Readonly<Record<string, LogService>> = {
	"portikus-api.service": "api",
	"portikus-worker.service": "worker",
	"portikus-controller.service": "controller",
};

/** One request reads at most this many entries ... */
export const MAX_SCAN_ENTRIES = 20_000;
/** ... or for this long, whichever comes first. */
export const SCAN_TIMEOUT_MS = 5_000;
/** journalctl processes running at once across the API. */
export const MAX_CONCURRENT_READS = 2;

/** journalctl is missing, failed, or may not read the journal. */
export class LogsUnavailableError extends Error {
	constructor(reason: string) {
		super(reason);
		this.name = "LogsUnavailableError";
	}
}

/** Every journalctl slot is taken. */
export class LogsBusyError extends Error {
	constructor() {
		super("log search is busy");
		this.name = "LogsBusyError";
	}
}

export interface JournalEntry {
	cursor: string;
	at: Date;
	service: LogService;
	/** The MESSAGE field decoded as UTF-8, or null when the journal omitted it. */
	message: string | null;
}

export interface ReadRequest {
	/** Newest first. */
	reverse: boolean;
	since?: Date;
	until?: Date;
	/** Already checked against journald's cursor syntax. */
	afterCursor?: string;
	/** Only these levels; absent or all four means no `--grep`. */
	levels?: readonly LogLevel[];
}

export interface ReadResult {
	/** The last entry read, whether or not the caller kept it. */
	lastCursor: string | null;
	/** "end": the journal had no more; "stopped": the caller had enough; "limit": the scan cap. */
	reason: "end" | "stopped" | "limit";
}

/** What the reader needs from a child process; tests hand in a fake. */
export interface JournalChild {
	stdout: Readable | null;
	stderr: Readable | null;
	kill(signal?: NodeJS.Signals): boolean;
	on(event: "error", listener: (error: Error) => void): this;
	on(event: "close", listener: (code: number | null) => void): this;
}

export type SpawnJournal = (path: string, args: readonly string[]) => JournalChild;

// journalctl gets no copy of the API's secrets, which a core dump would record.
const JOURNAL_ENV = { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" };

const spawnWithoutShell: SpawnJournal = (path, args) =>
	nodeSpawn(path, args, {
		shell: false,
		stdio: ["ignore", "pipe", "pipe"],
		env: JOURNAL_ENV,
	});

// The `--grep` alternatives for each level; fatal counts as error.
const LEVEL_PATTERN: Record<LogLevel, string> = {
	error: "error|fatal",
	warn: "warn",
	info: "info",
	debug: "debug",
};

// What journalctl prints, exiting 0, when it may not read the system journal.
const PERMISSION_HINTS = ["insufficient permissions", "not seeing messages"];

// journalctl takes whole seconds; --since rounds down and --until up, so a
// slice never skips lines at its edges (callers drop entries outside it).
function epochSeconds(date: Date, round: (n: number) => number): string {
	return `@${round(date.getTime() / 1000)}`;
}

/**
 * journalctl's arguments. Every value comes from the fixed lists above, a
 * server-computed date, or a cursor the caller validated; request text
 * never reaches an argument.
 */
export function journalArgs(request: ReadRequest): string[] {
	if (request.afterCursor !== undefined && !JOURNAL_CURSOR.test(request.afterCursor)) {
		throw new Error("invalid journal cursor");
	}
	const args = [
		"--output=json",
		"--output-fields=MESSAGE,_SYSTEMD_UNIT,_TRANSPORT,__REALTIME_TIMESTAMP",
		"--no-pager",
		// journalctl ORs values of one field, and "+" ORs the groups: the units, or the kernel.
		...Object.keys(PORTIKUS_UNITS).map((unit) => `_SYSTEMD_UNIT=${unit}`),
		"+",
		"_TRANSPORT=kernel",
	];
	if (request.reverse) args.push("--reverse");
	// journalctl refuses --since together with a cursor; the caller stops at `since` itself.
	if (request.since && !request.afterCursor)
		args.push(`--since=${epochSeconds(request.since, Math.floor)}`);
	if (request.until) args.push(`--until=${epochSeconds(request.until, Math.ceil)}`);
	if (request.afterCursor) args.push(`--after-cursor=${request.afterCursor}`);
	const levels = request.levels ?? [];
	const all = (Object.keys(LEVEL_PATTERN) as LogLevel[]).every((l) =>
		levels.includes(l),
	);
	if (levels.length > 0 && !all) {
		const parts = levels.map((level) => LEVEL_PATTERN[level]);
		const json = `"level":"(${parts.join("|")})"`;
		// The outbound-limit kernel lines are shown as warnings (kernel.ts).
		args.push(
			`--grep=${levels.includes("warn") ? `${json}|${KERNEL_LINE_PATTERN}` : json}`,
		);
	}
	return args;
}

// journalctl's own error text, never log content: its first line, capped.
function firstLine(stderr: string): string {
	const line = stderr.trim().split("\n")[0]?.trim().slice(0, 200) ?? "";
	return line ? `: ${line}` : "";
}

/** One `--output=json` line as an entry, or null when it is not a usable one. */
export function parseJournalLine(text: string): JournalEntry | null {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return null;
	}
	if (raw === null || typeof raw !== "object") return null;
	const record = raw as Record<string, unknown>;
	const cursor = record.__CURSOR;
	const unit = record._SYSTEMD_UNIT;
	const micros = record.__REALTIME_TIMESTAMP;
	if (typeof cursor !== "string" || !JOURNAL_CURSOR.test(cursor)) return null;
	const kernel = record._TRANSPORT === "kernel";
	let service: LogService | undefined;
	if (kernel) service = "network";
	else if (typeof unit === "string") service = PORTIKUS_UNITS[unit];
	if (!service) return null;
	if (typeof micros !== "string" || !/^[0-9]+$/.test(micros)) return null;
	const at = new Date(Number(BigInt(micros) / 1000n));

	// journald sends a field that is not valid UTF-8 as an array of bytes.
	const field = record.MESSAGE;
	let message: string | null = null;
	if (typeof field === "string") message = field;
	else if (Array.isArray(field) && field.every((b) => typeof b === "number")) {
		message = Buffer.from(field as number[]).toString("utf8");
	}
	if (kernel) {
		// Every other kernel line is dropped unread (docs/adr/0036).
		const line = kernelLineMessage(message, at);
		return line === null ? null : { cursor, at, service, message: line };
	}
	return { cursor, at, service, message };
}

export interface JournalReaderOptions {
	path: string;
	spawn?: SpawnJournal;
	maxEntries?: number;
	timeoutMs?: number;
	maxConcurrent?: number;
}

/**
 * Runs journalctl with a fixed argument list and no shell, at most
 * `maxConcurrent` at a time, and stops it at the entry or time cap.
 */
export class JournalReader {
	private running = 0;
	private readonly path: string;
	private readonly spawn: SpawnJournal;
	private readonly maxEntries: number;
	private readonly timeoutMs: number;
	private readonly maxConcurrent: number;

	constructor(options: JournalReaderOptions) {
		this.path = options.path;
		this.spawn = options.spawn ?? spawnWithoutShell;
		this.maxEntries = options.maxEntries ?? MAX_SCAN_ENTRIES;
		this.timeoutMs = options.timeoutMs ?? SCAN_TIMEOUT_MS;
		this.maxConcurrent = options.maxConcurrent ?? MAX_CONCURRENT_READS;
	}

	/** Call `onEntry` for each entry until it answers "stop", the journal ends, or a cap is hit. */
	async read(
		request: ReadRequest,
		onEntry: (entry: JournalEntry) => "continue" | "stop",
	): Promise<ReadResult> {
		if (this.running >= this.maxConcurrent) throw new LogsBusyError();
		const args = journalArgs(request);
		this.running++;
		try {
			return await this.run(args, onEntry);
		} finally {
			this.running--;
		}
	}

	private run(
		args: string[],
		onEntry: (entry: JournalEntry) => "continue" | "stop",
	): Promise<ReadResult> {
		return new Promise((resolve, reject) => {
			let child: JournalChild;
			try {
				child = this.spawn(this.path, args);
			} catch (error) {
				reject(new LogsUnavailableError(`journalctl did not start: ${String(error)}`));
				return;
			}
			let stopReason: "stopped" | "limit" | null = null;
			let lastCursor: string | null = null;
			let scanned = 0;
			let pending = "";
			let stderr = "";
			let failed = false;

			let settled = false;
			const settle = (result: ReadResult) => {
				if (settled) return;
				settled = true;
				resolve(result);
			};
			const stop = (reason: "stopped" | "limit") => {
				if (stopReason) return;
				stopReason = reason;
				child.kill("SIGKILL");
			};
			// Settle at the time cap even if the killed process never closes
			// (stuck in disk I/O), so its slot is freed.
			const timer = setTimeout(() => {
				stop("limit");
				settle({ lastCursor, reason: stopReason ?? "limit" });
			}, this.timeoutMs);

			const handleLine = (text: string) => {
				if (stopReason || text === "") return;
				const entry = parseJournalLine(text);
				if (!entry) return;
				scanned++;
				lastCursor = entry.cursor;
				if (onEntry(entry) === "stop") stop("stopped");
				else if (scanned >= this.maxEntries) stop("limit");
			};

			child.stdout?.setEncoding("utf8");
			child.stdout?.on("data", (chunk: string) => {
				pending += chunk;
				let newline = pending.indexOf("\n");
				while (newline !== -1 && !stopReason) {
					handleLine(pending.slice(0, newline));
					pending = pending.slice(newline + 1);
					newline = pending.indexOf("\n");
				}
			});
			child.stderr?.setEncoding("utf8");
			child.stderr?.on("data", (chunk: string) => {
				if (stderr.length < 4096) stderr += chunk;
			});
			child.on("error", (error) => {
				failed = true;
				clearTimeout(timer);
				if (settled) return;
				settled = true;
				reject(new LogsUnavailableError(`journalctl failed: ${error.message}`));
			});
			child.on("close", (code) => {
				clearTimeout(timer);
				if (failed || settled) return;
				if (stopReason) {
					settle({ lastCursor, reason: stopReason });
					return;
				}
				// A truncated last line (no newline) is dropped as unreadable.
				const refused = PERMISSION_HINTS.some((hint) => stderr.includes(hint));
				// With --grep, journalctl exits 1 and prints nothing when no entry matches.
				const noMatch = code === 1 && stderr.trim() === "";
				if (refused || (code !== 0 && !noMatch)) {
					settled = true;
					reject(
						new LogsUnavailableError(
							refused
								? "journalctl may not read the journal"
								: `journalctl exited ${code}${firstLine(stderr)}`,
						),
					);
					return;
				}
				settle({ lastCursor, reason: "end" });
			});
		});
	}
}
