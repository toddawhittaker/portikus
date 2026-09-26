import {
	type HealthSample,
	POOL_FULL_PERCENT,
	POOL_WARN_PERCENT,
	poolFillPercent,
} from "@portikus/contracts";
import type { Database } from "@portikus/db";
import type { Logger } from "@portikus/observability";
import { type Kysely, sql } from "kysely";
import { type ControllerClient, ControllerClientError } from "./controller-client.js";

/** How often the worker samples the host (Epic 11, "Decisions"). */
export const HEALTH_SAMPLE_SECONDS = 60;

/** How long one host snapshot may take before the sample records a failure. */
export const HOST_SNAPSHOT_TIMEOUT_MS = 20_000;

/** How long samples are kept. */
export const HEALTH_RETENTION_DAYS = 7;

/** A level re-arms only once the fill falls this many points below it. */
export const POOL_REARM_POINTS = 5;

/** 0 below every threshold, else the highest threshold the pool is held at. */
export type PoolLevel = 0 | typeof POOL_WARN_PERCENT | typeof POOL_FULL_PERCENT;

/**
 * The pool's alert level after a sample: the highest threshold the fill has
 * reached, kept until the fill falls POOL_REARM_POINTS below it, so a fill
 * wobbling around a threshold alerts once (EPIC-17 ruling 21).
 */
export function nextPoolLevel(previous: PoolLevel, fill: number): PoolLevel {
	for (const threshold of [POOL_FULL_PERCENT, POOL_WARN_PERCENT] as const) {
		if (fill >= threshold) return threshold;
		if (previous >= threshold && fill >= threshold - POOL_REARM_POINTS)
			return threshold;
	}
	return 0;
}

export interface HealthSamplerOptions {
	db: Kysely<Database>;
	controller: ControllerClient;
	logger: Logger;
	now?: () => Date;
}

/**
 * Build the tick that writes one `health_samples` row (SPEC.md §25.6). A row
 * is written even when the controller cannot be reached, so the age of the
 * newest row doubles as the worker's heartbeat. Old rows are pruned in the
 * same tick. A tick is skipped while the previous one is still running.
 */
export function createHealthSampler(
	options: HealthSamplerOptions,
): () => Promise<void> {
	const { db, controller, logger } = options;
	const now = options.now ?? (() => new Date());
	let inFlight = false;
	// Kept in memory only: a worker restart may repeat one alert, which is accepted.
	let poolLevel: PoolLevel = 0;

	return async function tick(): Promise<void> {
		if (inFlight) return;
		inFlight = true;
		try {
			let sample: HealthSample;
			try {
				sample = {
					controller: { reachable: true, errorCode: null },
					host: await controller.hostSnapshot(
						AbortSignal.timeout(HOST_SNAPSHOT_TIMEOUT_MS),
					),
				};
			} catch (e) {
				const errorCode =
					e instanceof ControllerClientError ? e.code : "OPERATION_FAILED";
				logger.debug({ errorCode }, "host snapshot failed");
				sample = { controller: { reachable: false, errorCode }, host: null };
			}
			const at = now();
			const inserted = await db
				.insertInto("health_samples")
				.values({ observed_at: at.toISOString(), sample: JSON.stringify(sample) })
				.returning("id")
				.executeTakeFirstOrThrow();
			// Only the newest sample keeps the per-instance list, so the series stays small.
			await db
				.updateTable("health_samples")
				.set({ sample: sql`jsonb_set(sample, '{host,instances}', '[]'::jsonb)` })
				.where("id", "<>", inserted.id)
				.where(sql<boolean>`jsonb_array_length(sample->'host'->'instances') > 0`)
				.execute();
			const cutoff = new Date(at.getTime() - HEALTH_RETENTION_DAYS * 86_400_000);
			await db.deleteFrom("health_samples").where("observed_at", "<", cutoff).execute();

			if (sample.host) {
				const fill = poolFillPercent(sample.host.pool);
				const level = nextPoolLevel(poolLevel, fill);
				if (level > poolLevel) {
					await notifyAdministrators(db, level, Math.floor(fill));
					logger.info(
						{ fillPercent: Math.floor(fill), level },
						"storage pool alert sent",
					);
				}
				poolLevel = level;
			}
		} catch (e) {
			logger.warn(
				{ error: e instanceof Error ? e.message : String(e) },
				"health sample failed",
			);
		} finally {
			inFlight = false;
		}
	};
}

/** Record a storage-pool notification for every enabled administrator (ADR 0033). */
async function notifyAdministrators(
	db: Kysely<Database>,
	level: PoolLevel,
	fill: number,
): Promise<void> {
	const full = level === POOL_FULL_PERCENT;
	const admins = await db
		.selectFrom("users")
		.select("id")
		.where("role", "=", "administrator")
		.where("disabled_at", "is", null)
		.execute();
	if (admins.length === 0) return;
	await db
		.insertInto("notifications")
		.values(
			admins.map((admin) => ({
				user_id: admin.id,
				tone: full ? "danger" : "warning",
				title: full
					? `Storage pool is ${fill}% full; new workspaces are refused`
					: `Storage pool is ${fill}% full`,
				body: "The Health tab on the admin page shows the details.",
			})),
		)
		.execute();
}

/** Run the sampler now and then every HEALTH_SAMPLE_SECONDS; returns a stop function. */
export function startHealthSampling(
	options: HealthSamplerOptions,
	tick: () => Promise<void> = createHealthSampler(options),
): () => void {
	const timer = setInterval(() => {
		void tick();
	}, HEALTH_SAMPLE_SECONDS * 1000);
	// Leave Node's default signal handling in place, as the log-level timer does.
	timer.unref();
	void tick();
	return () => clearInterval(timer);
}
