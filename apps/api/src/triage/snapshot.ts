import { HealthSample } from "@portikus/contracts";
import type { Database } from "@portikus/db";
import type { Kysely } from "kysely";
import { readLogPage } from "../logs/filter.js";
import type { JournalReader } from "../logs/journal.js";

/** How far back the error lines reach. */
const LOG_WINDOW_MS = 60 * 60_000;
const MAX_LOG_LINES = 20;
const LOG_LINE_CHARS = 300;
const ALERT_BODY_CHARS = 2000;

/** One alert as code reads it from the notifications table. */
export type TriageAlert = {
	title: string;
	body: string;
	tone: "warning" | "danger";
	at: Date;
};

export type ReadErrorLines = (since: Date) => Promise<string[] | null>;

function cut(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}…` : text;
}

function oneLine(value: unknown): string {
	if (value === undefined || value === null) return "";
	const text = typeof value === "string" ? value : JSON.stringify(value);
	return text.replace(/\s+/g, " ").trim();
}

/**
 * The newest error lines, already redacted by `readLogPage`, as short text:
 * time, service, message, code and error only. Null when the journal cannot
 * be read.
 */
export function journalErrorLines(reader: JournalReader): ReadErrorLines {
	return async (since) => {
		try {
			const page = await readLogPage(
				reader,
				{ level: ["error"], since: since.toISOString() },
				null,
			);
			return page.lines
				.slice(0, MAX_LOG_LINES)
				.map(({ at, service, line }) =>
					cut(
						[at.toISOString(), service, line.msg, line.code, line.error]
							.map(oneLine)
							.filter(Boolean)
							.join(" "),
						LOG_LINE_CHARS,
					),
				);
		} catch {
			return null;
		}
	};
}

/** The newest health sample as fixed figures; instance names and images are left out. */
async function healthLines(db: Kysely<Database>): Promise<string[]> {
	const row = await db
		.selectFrom("health_samples")
		.select(["observed_at", "sample"])
		.orderBy("observed_at", "desc")
		.limit(1)
		.executeTakeFirst();
	const parsed = row ? HealthSample.safeParse(row.sample) : null;
	if (!row || !parsed?.success) return ["No health sample."];
	const { controller, host, runningWorkspaces } = parsed.data;
	const gib = (bytes: number) => `${(bytes / 2 ** 30).toFixed(1)} GiB`;
	const lines = [
		`Sampled at ${row.observed_at.toISOString()}.`,
		`Workspace controller reachable: ${controller.reachable ? "yes" : "no"}${
			controller.errorCode ? ` (${controller.errorCode})` : ""
		}.`,
		`Running workspaces: ${runningWorkspaces ?? "unknown"}.`,
	];
	if (!host) return [...lines, "No host figures."];
	return [
		...lines,
		`Load average: ${host.loadAverage.join(", ")} on ${host.cpuCount} CPUs.`,
		`Memory: ${gib(host.memory.usedBytes)} of ${gib(host.memory.totalBytes)} used.`,
		`Storage pool: ${gib(host.pool.usedBytes)} of ${gib(host.pool.totalBytes)} used${
			host.pool.metadataPercent === null
				? ""
				: `, metadata ${host.pool.metadataPercent}%`
		}.`,
		`Workspace instances: ${host.instances.length}.`,
	];
}

/**
 * The fixed facts one explanation is given (SPEC.md section 20.4): the
 * alert, the newest health sample and recent error lines. Code picks every
 * read; nothing here holds a secret, a prompt, source code or terminal bytes.
 * Sized to stay near 5,000 input tokens.
 */
export async function collectSnapshot(
	db: Kysely<Database>,
	readErrorLines: ReadErrorLines,
	alert: TriageAlert,
	now: Date,
): Promise<string> {
	const health = await healthLines(db);
	const logs = await readErrorLines(new Date(now.getTime() - LOG_WINDOW_MS));
	return [
		"<alert>",
		`Tone: ${alert.tone}. Raised at ${alert.at.toISOString()}.`,
		`Title: ${alert.title}`,
		cut(alert.body, ALERT_BODY_CHARS),
		"</alert>",
		"<health>",
		...health,
		"</health>",
		"<error-log-lines newest-first>",
		...(logs === null
			? ["The logs could not be read."]
			: logs.length === 0
				? ["No error lines in the last hour."]
				: logs),
		"</error-log-lines>",
	].join("\n");
}
