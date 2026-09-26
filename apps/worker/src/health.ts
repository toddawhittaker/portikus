import type { HealthSample } from "@portikus/contracts";
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

	return async function tick(): Promise<void> {
		if (inFlight) return;
		inFlight = true;
		try {
			let sample: HealthSample;
			// The database, not the controller, is the source of truth for state.
			const running = await db
				.selectFrom("workspaces")
				.select((eb) => eb.fn.countAll<string>().as("n"))
				.where("state", "=", "running")
				.executeTakeFirstOrThrow();
			const runningWorkspaces = Number(running.n);
			try {
				sample = {
					controller: { reachable: true, errorCode: null },
					host: await controller.hostSnapshot(
						AbortSignal.timeout(HOST_SNAPSHOT_TIMEOUT_MS),
					),
					runningWorkspaces,
				};
			} catch (e) {
				const errorCode =
					e instanceof ControllerClientError ? e.code : "OPERATION_FAILED";
				logger.debug({ errorCode }, "host snapshot failed");
				sample = {
					controller: { reachable: false, errorCode },
					host: null,
					runningWorkspaces,
				};
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
