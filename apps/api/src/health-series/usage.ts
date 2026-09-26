import { effectiveGuard, type HealthSeries } from "@portikus/contracts";
import type { Database } from "@portikus/db";
import type { Kysely } from "kysely";
import type { SeriesWindow } from "./range.js";

/**
 * How long the worker keeps `workspace_usage_samples`: its
 * SAMPLE_RETENTION_MINUTES in apps/worker/src/guard.ts, which the API cannot
 * import. Keep the two equal.
 */
export const USAGE_RETENTION_MINUTES = 245;

/** The heat map shows at most this many workspaces, the busiest (ruling 18). */
export const USAGE_MAX_ROWS = 50;

/** One guard sample interval, for the restart tail (apps/worker/src/guard.ts). */
const SAMPLE_MS = 60_000;

interface Sample {
	observedAt: Date;
	cpuUsageNs: bigint;
	bootMarker: string | null;
	cpuLimit: number;
	memoryBytes: number;
	memoryLimitBytes: number;
}

/** The worker's restartedBetween: the boot marker changed or the counter dropped. */
function restartedBetween(prev: Sample, cur: Sample): boolean {
	const bothMarkers = prev.bootMarker !== null && cur.bootMarker !== null;
	return (
		(bothMarkers && prev.bootMarker !== cur.bootMarker) ||
		cur.cpuUsageNs < prev.cpuUsageNs
	);
}

/**
 * CPU % between two consecutive samples with the guard's arithmetic: the CPU
 * time used over the limit's allowance for the elapsed time. Across a
 * restart the later counter counts in full, plus up to one interval of full
 * use, as the guard counts it.
 */
export function pairCpuPercent(prev: Sample, cur: Sample): number | null {
	const elapsedMs = cur.observedAt.getTime() - prev.observedAt.getTime();
	if (elapsedMs <= 0 || cur.cpuLimit <= 0) return null;
	let usedNs: bigint;
	if (restartedBetween(prev, cur)) {
		const tailMs = Math.min(elapsedMs, SAMPLE_MS);
		usedNs = cur.cpuUsageNs + BigInt(tailMs) * 1_000_000n * BigInt(cur.cpuLimit);
	} else {
		usedNs = cur.cpuUsageNs - prev.cpuUsageNs;
	}
	return (Number(usedNs) / (elapsedMs * 1e6 * cur.cpuLimit)) * 100;
}

/** The start of the first bucket the heat map shows: never before retention. */
export function usageFrom(window: SeriesWindow): Date {
	const bucketMs = window.bucketSeconds * 1000;
	const cutoff = window.to.getTime() - USAGE_RETENTION_MINUTES * 60_000;
	if (cutoff <= window.from.getTime()) return window.from;
	const offset = Math.floor((cutoff - window.from.getTime()) / bucketMs) * bucketMs;
	return new Date(window.from.getTime() + offset);
}

type Row = HealthSeries["usage"]["workspaces"][number];

/**
 * The per-workspace heat map (docs/EPIC-19.md ruling 18): one row per
 * workspace with a sample in the window, one cell per bucket holding the
 * highest CPU % and memory % in it, the thresholds the guard applies to that
 * workspace, capped at the 50 highest peaks and sorted by owner name.
 */
export async function usageSeries(
	db: Kysely<Database>,
	window: SeriesWindow,
): Promise<HealthSeries["usage"]> {
	const from = usageFrom(window);
	const body = {
		retentionMinutes: USAGE_RETENTION_MINUTES,
		from: from.toISOString(),
	};
	const rows = await db
		.selectFrom("workspace_usage_samples as s")
		.innerJoin("workspaces as w", "w.id", "s.workspace_id")
		.innerJoin("users as u", "u.id", "w.owner_user_id")
		.select([
			"s.workspace_id",
			"s.observed_at",
			"s.cpu_usage_ns",
			"s.boot_marker",
			"s.cpu_limit",
			"s.memory_bytes",
			"s.memory_limit_bytes",
			"w.guard_config",
			"u.id as owner_id",
			"u.display_name",
		])
		.where("s.observed_at", ">=", from)
		.where("s.observed_at", "<", window.to)
		.orderBy("s.workspace_id")
		.orderBy("s.observed_at")
		.orderBy("s.id")
		.execute();
	if (rows.length === 0) return { ...body, workspaces: [] };

	const settings = await db
		.selectFrom("settings")
		.select([
			"cpu_guard_threshold_percent",
			"memory_guard_threshold_percent",
			"guard_window_minutes",
			"cpu_throttle_share_percent",
			"idle_stop_minutes",
		])
		.where("id", "=", 1)
		.executeTakeFirst();
	// The worker seeds settings before it records any sample.
	if (!settings) return { ...body, workspaces: [] };

	const bucketMs = window.bucketSeconds * 1000;
	// Rows arrive ordered by workspace, then time.
	const entries = new Map<
		string,
		{
			row: Row;
			cells: Map<number, Row["cells"][number]>;
			peak: number;
			prev: Sample | null;
		}
	>();
	for (const r of rows) {
		let entry = entries.get(r.workspace_id);
		if (!entry) {
			const effective = effectiveGuard(settings, r.guard_config);
			entry = {
				row: {
					workspaceId: r.workspace_id,
					owner: { id: r.owner_id, displayName: r.display_name },
					cpuThresholdPercent: effective.cpuThresholdPercent,
					memoryThresholdPercent: effective.memoryThresholdPercent,
					cells: [],
				},
				cells: new Map(),
				peak: 0,
				prev: null,
			};
			entries.set(r.workspace_id, entry);
		}
		const sample: Sample = {
			observedAt: new Date(r.observed_at),
			cpuUsageNs: BigInt(r.cpu_usage_ns),
			bootMarker: r.boot_marker,
			cpuLimit: r.cpu_limit,
			memoryBytes: Number(r.memory_bytes),
			memoryLimitBytes: Number(r.memory_limit_bytes),
		};
		const cpu = entry.prev ? pairCpuPercent(entry.prev, sample) : null;
		const memory =
			sample.memoryLimitBytes > 0
				? (sample.memoryBytes / sample.memoryLimitBytes) * 100
				: null;
		entry.prev = sample;

		const start =
			window.from.getTime() +
			Math.floor((sample.observedAt.getTime() - window.from.getTime()) / bucketMs) *
				bucketMs;
		const cell = entry.cells.get(start) ?? {
			at: new Date(start).toISOString(),
			cpuPercent: null,
			memoryPercent: null,
		};
		// Percentages keep the highest value in the bucket (ruling 4).
		if (cpu !== null) cell.cpuPercent = Math.max(cell.cpuPercent ?? 0, round1(cpu));
		if (memory !== null)
			cell.memoryPercent = Math.max(cell.memoryPercent ?? 0, round1(memory));
		entry.cells.set(start, cell);
		entry.peak = Math.max(entry.peak, cpu ?? 0, memory ?? 0);
	}
	const built = [...entries.values()].map((entry) => ({
		peak: entry.peak,
		row: {
			...entry.row,
			cells: [...entry.cells.entries()]
				.sort(([a], [b]) => a - b)
				.map(([, cell]) => cell),
		},
	}));

	const kept = built
		.sort((a, b) => b.peak - a.peak)
		.slice(0, USAGE_MAX_ROWS)
		.map((entry) => entry.row)
		.sort(
			(a, b) =>
				a.owner.displayName.localeCompare(b.owner.displayName) ||
				a.workspaceId.localeCompare(b.workspaceId),
		);
	return { ...body, workspaces: kept };
}

function round1(value: number): number {
	return Math.round(value * 10) / 10;
}
