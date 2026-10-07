import type { LogService } from "@portikus/contracts";
import { type Database, type Notice, notifyAdministrators } from "@portikus/db";
import { errorMessage, type Logger } from "@portikus/observability";
import type { Kysely } from "kysely";
import type { JournalEntry, ReadRequest, ReadResult } from "../logs/journal.js";

/**
 * Alert sources read from the journal (STACK.md section 15, ADR 0052). They
 * live in the API because it is the only unit allowed to read the journal.
 * Alerts leave the site, so their text names an Incus instance and fixed
 * words only: never an email, and never a log line (ADR 0012).
 */

const LOG_ALERTS_SECONDS = 60;
/** One outbound-limit alert per workspace and reason in this long. */
const LIMIT_ALERT_INTERVAL_MS = 60 * 60_000;
/** Error lines counted over this window... */
const ERROR_SPIKE_WINDOW_MINUTES = 15;
/** ...raise an alert when they reach this many. */
export const ERROR_SPIKE_THRESHOLD = 20;

/** What the alerts need from `JournalReader`; tests hand in a fake. */
export interface LogAlertReader {
	read(
		request: ReadRequest,
		onEntry: (entry: JournalEntry) => "continue" | "stop",
	): Promise<ReadResult>;
}

const LIMIT_REASONS: Readonly<Record<string, string>> = {
	WORKSPACE_MAIL_BLOCKED: "was blocked from sending mail (port 25)",
	WORKSPACE_CONN_LIMIT: "hit the new-connection limit",
	WORKSPACE_PACKET_LIMIT: "hit the packet limit",
};

const SERVICE_UNITS: Readonly<Record<LogService, string>> = {
	api: "portikus-api",
	worker: "portikus-worker",
	controller: "portikus-controller",
	network: "kernel",
};

export type ParsedEntry =
	| { kind: "limit"; code: string; address: string; at: Date }
	| { kind: "error"; service: LogService; at: Date }
	| null;

/** Classify one entry; only its code, address, level and unit are kept. */
export function classifyEntry(entry: JournalEntry): ParsedEntry {
	if (entry.message === null) return null;
	let record: unknown;
	try {
		record = JSON.parse(entry.message);
	} catch {
		return null;
	}
	if (record === null || typeof record !== "object") return null;
	const fields = record as Record<string, unknown>;
	if (entry.service === "network") {
		const code = fields.code;
		const address = fields.workspaceAddress;
		if (typeof code !== "string" || !(code in LIMIT_REASONS)) return null;
		if (typeof address !== "string") return null;
		return { kind: "limit", code, address, at: entry.at };
	}
	if (fields.level === "error" || fields.level === "fatal") {
		return { kind: "error", service: entry.service, at: entry.at };
	}
	return null;
}

function limitNotice(instance: string, code: string): Notice {
	return {
		tone: "warning",
		title: `Workspace ${instance} ${LIMIT_REASONS[code] ?? "hit an outbound limit"}`,
		body: "Open Admin, then Logs, and filter by this workspace to see when.",
	};
}

/** A fixed sentence: error lines may carry user ids, paths or student text. */
function errorSpikeNotice(count: number, services: readonly LogService[]): Notice {
	const units = [...new Set(services)]
		.sort()
		.map((s) => SERVICE_UNITS[s])
		.join(", ");
	return {
		tone: "warning",
		title: `${count} errors in the last ${ERROR_SPIKE_WINDOW_MINUTES} minutes`,
		body: `From ${units}. Open Admin, then Logs, and show errors to read them.`,
	};
}

export interface LogAlertOptions {
	db: Kysely<Database>;
	logger: Logger;
	reader: LogAlertReader;
	now?: () => Date;
	/** Look up an Incus instance name by workspace address; replaceable in tests. */
	instanceAt?: (address: string) => Promise<string | null>;
	notify?: (notice: Notice) => Promise<void>;
}

/** Build the tick; state is in memory, so a restart may repeat one alert. */
export function createLogAlerts(options: LogAlertOptions): () => Promise<void> {
	const { db, logger, reader } = options;
	const now = options.now ?? (() => new Date());
	const notify = options.notify ?? ((notice) => notifyAdministrators(db, notice));
	const instanceAt =
		options.instanceAt ??
		(async (address: string) => {
			const row = await db
				.selectFrom("workspaces")
				.select("incus_instance_name")
				.where("agent_address", "=", address)
				.executeTakeFirst();
			return row?.incus_instance_name ?? null;
		});

	let cursor: string | undefined;
	let started: Date | undefined;
	const lastLimitAlert = new Map<string, number>();
	let errors: { at: Date; service: LogService }[] = [];
	let spikeRaised = false;

	return async function tick(): Promise<void> {
		const at = now();
		const entries: ParsedEntry[] = [];
		try {
			// The first read starts now, so a restart does not replay old lines.
			started ??= at;
			const request: ReadRequest = { reverse: false, levels: ["error", "warn"] };
			if (cursor) request.afterCursor = cursor;
			else request.since = started;
			const result = await reader.read(request, (entry) => {
				entries.push(classifyEntry(entry));
				return "continue";
			});
			if (result.lastCursor) cursor = result.lastCursor;
		} catch (e) {
			// A busy or missing journal skips this tick.
			logger.debug({ error: errorMessage(e) }, "log alert read skipped");
			return;
		}

		try {
			for (const parsed of entries) {
				if (parsed?.kind === "error") errors.push(parsed);
				if (parsed?.kind !== "limit") continue;
				const instance = await instanceAt(parsed.address);
				if (!instance) continue;
				const key = `${instance}/${parsed.code}`;
				const last = lastLimitAlert.get(key);
				if (last !== undefined && at.getTime() - last < LIMIT_ALERT_INTERVAL_MS)
					continue;
				lastLimitAlert.set(key, at.getTime());
				await notify(limitNotice(instance, parsed.code));
				logger.info({ instance, code: parsed.code }, "outbound limit alert raised");
			}
			for (const [key, last] of lastLimitAlert) {
				if (at.getTime() - last >= LIMIT_ALERT_INTERVAL_MS) lastLimitAlert.delete(key);
			}

			const since = at.getTime() - ERROR_SPIKE_WINDOW_MINUTES * 60_000;
			errors = errors.filter((e) => e.at.getTime() > since);
			const spike = errors.length >= ERROR_SPIKE_THRESHOLD;
			if (spike && !spikeRaised) {
				await notify(
					errorSpikeNotice(
						errors.length,
						errors.map((e) => e.service),
					),
				);
				logger.info({ errors: errors.length }, "error spike alert raised");
			}
			spikeRaised = spike;
		} catch (e) {
			logger.warn({ error: errorMessage(e) }, "log alert check failed");
		}
	};
}

/** Check every minute; the returned stop waits for a tick in flight. */
export function startLogAlerts(options: LogAlertOptions): () => Promise<void> {
	const tick = createLogAlerts(options);
	let running: Promise<void> | null = null;
	let stopped = false;
	const run = () => {
		if (stopped || running) return;
		running = tick().finally(() => {
			running = null;
		});
	};
	const timer = setInterval(run, LOG_ALERTS_SECONDS * 1000);
	timer.unref();
	run();
	return async () => {
		stopped = true;
		clearInterval(timer);
		await running;
	};
}
