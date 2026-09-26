import { z } from "zod";

/** The Health tab's time spans (SPEC.md §25.6). */
export const HealthRange = z.enum(["1h", "6h", "1d", "7d"]);
export type HealthRange = z.infer<typeof HealthRange>;

/** Query of `GET /admin/health/series`. */
export const HealthSeriesQuery = z.object({ range: HealthRange }).strict();
export type HealthSeriesQuery = z.infer<typeof HealthSeriesQuery>;

/** Seconds per bucket for each range: 60, 72, 96 and 168 buckets. */
export const HEALTH_BUCKET_SECONDS: Record<HealthRange, number> = {
	"1h": 60,
	"6h": 300,
	"1d": 900,
	"7d": 3600,
};

/** Seconds each range spans. */
export const HEALTH_RANGE_SECONDS: Record<HealthRange, number> = {
	"1h": 3600,
	"6h": 6 * 3600,
	"1d": 24 * 3600,
	"7d": 7 * 24 * 3600,
};

const at = z.string().datetime();
const count = z.number().int().nonnegative();
const rate = z.number().nonnegative().nullable();

/**
 * Body of `GET /admin/health/series` (docs/EPIC-19.md, "The HealthSeries
 * contract"). Every array holds one entry per bucket that has data, oldest
 * first, keyed by the bucket's start `at`; a bucket with no data is absent,
 * and the chart draws a gap there.
 */
export const HealthSeries = z.object({
	range: HealthRange,
	bucketSeconds: z.number().int().positive(),
	/** The range's edges, aligned to buckets. */
	from: at,
	to: at,
	/** From the newest sample, for the load chart's reference line. */
	cpuCount: z.number().int().positive().nullable(),
	/** Maxima per bucket. */
	host: z.array(
		z.object({
			at,
			poolPercent: z.number(),
			memoryPercent: z.number(),
			load1: z.number(),
			load5: z.number(),
			load15: z.number(),
		}),
	),
	platform: z.array(
		z.object({
			at,
			sampleMinutes: count,
			reachableMinutes: count,
			runningWorkspaces: z.number().nullable(),
			cpuPercent: z.number().nullable(),
			netRxBytesPerSecond: rate,
			netTxBytesPerSecond: rate,
			diskReadBytesPerSecond: rate,
			diskWriteBytesPerSecond: rate,
		}),
	),
	events: z.array(
		z.object({
			at,
			throttles: count,
			memoryFlags: count,
			idleStops: count,
			guardLifts: count,
			starts: count,
			stops: count,
			signIns: count,
		}),
	),
	usage: z.object({
		retentionMinutes: count,
		from: at,
		workspaces: z.array(
			z.object({
				workspaceId: z.string().uuid(),
				owner: z.object({ id: z.string().uuid(), displayName: z.string() }),
				cpuThresholdPercent: z.number(),
				memoryThresholdPercent: z.number(),
				cells: z.array(
					z.object({
						at,
						cpuPercent: z.number().nullable(),
						memoryPercent: z.number().nullable(),
					}),
				),
			}),
		),
	}),
	api: z.array(
		z.object({
			at,
			requests: count,
			clientErrors: count,
			serverErrors: count,
			webSocketUpgrades: count,
			medianMs: z.number().nullable(),
			p95Ms: z.number().nullable(),
		}),
	),
});
export type HealthSeries = z.infer<typeof HealthSeries>;
