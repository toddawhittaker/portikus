import { estimate, type HealthRange } from "@portikus/contracts";
import type { Database } from "@portikus/db";
import { type Kysely, sql } from "kysely";
import { apiRequestSeries } from "../health-series/api-requests.js";
import { eventSeries } from "../health-series/events.js";
import { platformSeries } from "../health-series/platform.js";
import { seriesWindow } from "../health-series/range.js";
import { siteSwitches } from "../site/switches.js";

const RANGE: HealthRange = "7d";

const sum = (values: readonly number[]) => values.reduce((a, b) => a + b, 0);
const peak = (values: readonly (number | null)[]) =>
	values.reduce<number | null>(
		(best, v) => (v === null ? best : Math.max(best ?? v, v)),
		null,
	);

export interface WeekHealth {
	lines: string[];
	/** The most workspaces running at once in a sample bucket; null with no samples. */
	peakRunning: number | null;
	starts: number;
}

/** The server's health over the last seven days, as plain lines, with the figures other sections reuse. */
export async function weekHealth(db: Kysely<Database>, now: Date): Promise<WeekHealth> {
	const window = seriesWindow(RANGE, now);
	const [platform, api, events] = await Promise.all([
		platformSeries(db, window),
		apiRequestSeries(db, window),
		eventSeries(db, window),
	]);
	const lines: string[] = [];
	const sampled = sum(platform.map((p) => p.sampleMinutes));
	if (sampled === 0) {
		lines.push("No health samples were recorded.");
	} else {
		const up = (sum(platform.map((p) => p.reachableMinutes)) / sampled) * 100;
		lines.push(
			`The workspace controller answered ${up.toFixed(1)}% of sampled minutes.`,
		);
		const cpu = peak(platform.map((p) => p.cpuPercent));
		if (cpu !== null) lines.push(`Peak server CPU: ${Math.round(cpu)}%.`);
	}
	const requests = sum(api.map((a) => a.requests));
	if (requests > 0) {
		const errors = sum(api.map((a) => a.serverErrors));
		const slowest = peak(api.map((a) => a.p95Ms));
		lines.push(
			`API: ${requests} requests, ${errors} server errors` +
				(slowest === null
					? "."
					: `, slowest 95th percentile ${Math.round(slowest)} ms.`),
		);
	}
	const total = (key: "throttles" | "memoryFlags" | "idleStops") =>
		sum(events.map((e) => e[key]));
	lines.push(
		`Usage guard: ${total("throttles")} CPU throttles, ${total("memoryFlags")} memory flags, ${total("idleStops")} idle stops.`,
	);
	return {
		lines,
		peakRunning: peak(platform.map((p) => p.runningWorkspaces)),
		starts: sum(events.map((e) => e.starts)),
	};
}

/**
 * The week's peak running workspaces against how many students the server's
 * memory holds with the ticked code-help languages (docs/CAPACITY.md).
 */
export async function capacityLines(
	db: Kysely<Database>,
	running: number | null,
): Promise<string[]> {
	const newest = await db
		.selectFrom("health_samples")
		.select(sql<string | null>`sample->'host'->'memory'->>'totalBytes'`.as("total"))
		.orderBy("observed_at", "desc")
		.limit(1)
		.executeTakeFirst();
	const totalBytes = newest?.total ? Number(newest.total) : null;
	const { codeHelpLanguages } = await siteSwitches(db);
	const holds = estimate(totalBytes, codeHelpLanguages);
	const peakText =
		running === null
			? "Peak running workspaces: not recorded."
			: `Peak running workspaces: ${running}.`;
	if (holds.traditional.students === null || holds.agentic.students === null)
		return [
			peakText,
			"The server's memory is not known, so its capacity is not estimated.",
		];
	return [
		`${peakText} The server holds about ${holds.traditional.students} students in a Traditional course or ${holds.agentic.students} in an Agentic one.`,
	];
}
