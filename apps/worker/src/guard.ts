import {
	type EffectiveGuard,
	effectiveGuard,
	type InstanceUsage,
} from "@portikus/contracts";
import type { Database } from "@portikus/db";
import type { Logger } from "@portikus/observability";
import type { Kysely } from "kysely";
import { type ControllerClient, ControllerClientError } from "./controller-client.js";

/** How often the guard samples every running workspace (ADR 0032). */
export const GUARD_SAMPLE_SECONDS = 60;

/** How long one usage listing may take before the tick gives up. */
export const USAGE_TIMEOUT_MS = 20_000;

/** Samples older than the longest allowed window plus five minutes are pruned. */
export const SAMPLE_RETENTION_MINUTES = 240 + 5;

export interface GuardOptions {
	db: Kysely<Database>;
	controller: ControllerClient;
	logger: Logger;
	now?: () => Date;
}

type Throttle = NonNullable<Database["workspaces"]["cpu_throttle"]["__select__"]>;

/** The time slice for `share` percent of `cpuLimit` CPUs, never a percentage (ADR 0032). */
export function allowanceFor(sharePercent: number, cpuLimit: number): string {
	const ms = Math.max(1, Math.round((sharePercent / 100) * cpuLimit * 100));
	return `${ms}ms/100ms`;
}

/** Round to one decimal place for the stored average. */
function round1(value: number): number {
	return Math.round(value * 10) / 10;
}

/**
 * Build the resource guard tick (ADR 0032). Each tick reads every running
 * instance's CPU time and memory from the controller, stores one sample per
 * running workspace, throttles a workspace whose CPU average over the window
 * is above its threshold, flags one whose memory average is, and makes each
 * instance's CPU allowance match the database. A failed allowance write is
 * audited once and retried on the next tick.
 */
export function createGuard(options: GuardOptions): () => Promise<void> {
	const { db, controller, logger } = options;
	const now = options.now ?? (() => new Date());
	// Workspace id to the allowance whose write failed, so each failure is audited once.
	const failures = new Map<string, string | null>();
	let inFlight = false;

	return async function tick(): Promise<void> {
		if (inFlight) return;
		inFlight = true;
		try {
			let usage: InstanceUsage[];
			try {
				usage = await controller.usage(AbortSignal.timeout(USAGE_TIMEOUT_MS));
			} catch (e) {
				const errorCode =
					e instanceof ControllerClientError ? e.code : "OPERATION_FAILED";
				logger.warn({ errorCode }, "guard usage read failed");
				return;
			}
			const at = now();
			const byName = new Map(usage.map((u) => [u.name, u]));

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

			const rows = await db
				.selectFrom("workspaces")
				.select([
					"id",
					"incus_instance_name",
					"guard_config",
					"cpu_throttle",
					"memory_flag",
				])
				.where("state", "=", "running")
				.where("incus_instance_name", "is not", null)
				.execute();

			for (const row of rows) {
				const inst = row.incus_instance_name
					? byName.get(row.incus_instance_name)
					: undefined;
				if (!inst) continue;
				try {
					let throttle = row.cpu_throttle;
					await recordSample(row.id, inst, at);
					if (settings) {
						const effective = effectiveGuard(settings, row.guard_config);
						if (!throttle) throttle = await judgeCpu(row.id, inst, effective, at);
						if (!row.memory_flag) await judgeMemory(row.id, effective, at);
					}
					await syncAllowance(row.id, inst, throttle?.allowance ?? null);
				} catch (e) {
					logger.warn(
						{
							workspaceId: row.id,
							error: e instanceof Error ? e.message : String(e),
						},
						"guard workspace check failed",
					);
				}
			}

			const cutoff = new Date(at.getTime() - SAMPLE_RETENTION_MINUTES * 60_000);
			await db
				.deleteFrom("workspace_usage_samples")
				.where("observed_at", "<", cutoff)
				.execute();
		} catch (e) {
			logger.warn(
				{ error: e instanceof Error ? e.message : String(e) },
				"guard tick failed",
			);
		} finally {
			inFlight = false;
		}
	};

	async function recordSample(
		id: string,
		inst: InstanceUsage,
		at: Date,
	): Promise<void> {
		await db
			.insertInto("workspace_usage_samples")
			.values({
				workspace_id: id,
				observed_at: at.toISOString(),
				cpu_usage_ns: inst.cpuUsageNs,
				cpu_limit: inst.cpuLimit,
				memory_bytes: inst.memoryBytes,
				memory_limit_bytes: inst.memoryLimitBytes,
			})
			.execute();
	}

	/**
	 * Throttle when CPU use over the last window of wall-clock time averages
	 * above the threshold; returns the new row. Usage is remembered across
	 * restarts (Todd's ruling, 2026-09-25): the CPU time between consecutive
	 * samples is summed, a counter drop counts as a restart from zero, and
	 * stopped time counts as no use. The first judgement waits until the
	 * oldest kept sample is at least a window old, stopped time included.
	 */
	async function judgeCpu(
		id: string,
		inst: InstanceUsage,
		effective: EffectiveGuard,
		at: Date,
	): Promise<Throttle | null> {
		const windowStart = new Date(at.getTime() - effective.windowMinutes * 60_000);
		const anchor = await db
			.selectFrom("workspace_usage_samples")
			.select("observed_at")
			.where("workspace_id", "=", id)
			.where("observed_at", "<=", windowStart)
			.orderBy("observed_at", "desc")
			.limit(1)
			.executeTakeFirst();
		if (!anchor) return null;
		const samples = await db
			.selectFrom("workspace_usage_samples")
			.select("cpu_usage_ns")
			.where("workspace_id", "=", id)
			.where("observed_at", ">=", anchor.observed_at)
			.where("observed_at", "<=", at)
			.orderBy("observed_at", "asc")
			.orderBy("id", "asc")
			.execute();
		let usedNs = 0n;
		for (let i = 1; i < samples.length; i++) {
			const before = BigInt(samples[i - 1]?.cpu_usage_ns ?? 0);
			const after = BigInt(samples[i]?.cpu_usage_ns ?? 0);
			usedNs += after >= before ? after - before : after;
		}
		const elapsedNs = (at.getTime() - anchor.observed_at.getTime()) * 1e6;
		if (elapsedNs <= 0) return null;
		const average = (Number(usedNs) / (elapsedNs * inst.cpuLimit)) * 100;
		if (!(average > effective.cpuThresholdPercent)) return null;

		const throttle: Throttle = {
			at: at.toISOString(),
			averagePercent: round1(average),
			thresholdPercent: effective.cpuThresholdPercent,
			windowMinutes: effective.windowMinutes,
			sharePercent: effective.throttleSharePercent,
			allowance: allowanceFor(effective.throttleSharePercent, inst.cpuLimit),
		};
		const written = await db.transaction().execute(async (trx) => {
			const updated = await trx
				.updateTable("workspaces")
				.set({ cpu_throttle: JSON.stringify(throttle) })
				.where("id", "=", id)
				.where("state", "=", "running")
				.where("cpu_throttle", "is", null)
				.executeTakeFirst();
			if (Number(updated.numUpdatedRows) === 0) return false;
			await trx
				.insertInto("audit_events")
				.values({
					actor: "worker",
					target: id,
					action: "workspace.cpu_throttled",
					result: "ok",
					metadata: JSON.stringify({
						averagePercent: throttle.averagePercent,
						thresholdPercent: throttle.thresholdPercent,
						windowMinutes: throttle.windowMinutes,
						sharePercent: throttle.sharePercent,
						allowance: throttle.allowance,
					}),
				})
				.execute();
			return true;
		});
		if (!written) return null;
		logger.info(
			{ workspaceId: id, averagePercent: throttle.averagePercent },
			"cpu throttled",
		);
		return throttle;
	}

	/** Flag when memory over the window averages above the threshold, with at least half the samples. */
	async function judgeMemory(
		id: string,
		effective: EffectiveGuard,
		at: Date,
	): Promise<void> {
		const windowStart = new Date(at.getTime() - effective.windowMinutes * 60_000);
		const samples = await db
			.selectFrom("workspace_usage_samples")
			.select(["memory_bytes", "memory_limit_bytes"])
			.where("workspace_id", "=", id)
			.where("observed_at", ">", windowStart)
			.execute();
		if (samples.length === 0 || samples.length < effective.windowMinutes / 2) return;
		let sum = 0;
		for (const s of samples)
			sum += Number(s.memory_bytes) / Number(s.memory_limit_bytes);
		const average = (sum / samples.length) * 100;
		if (!(average > effective.memoryThresholdPercent)) return;

		const flag = {
			at: at.toISOString(),
			averagePercent: round1(average),
			thresholdPercent: effective.memoryThresholdPercent,
			windowMinutes: effective.windowMinutes,
		};
		const written = await db.transaction().execute(async (trx) => {
			const updated = await trx
				.updateTable("workspaces")
				.set({ memory_flag: JSON.stringify(flag) })
				.where("id", "=", id)
				.where("state", "=", "running")
				.where("memory_flag", "is", null)
				.executeTakeFirst();
			if (Number(updated.numUpdatedRows) === 0) return false;
			await trx
				.insertInto("audit_events")
				.values({
					actor: "worker",
					target: id,
					action: "workspace.memory_flagged",
					result: "ok",
					metadata: JSON.stringify({
						averagePercent: flag.averagePercent,
						thresholdPercent: flag.thresholdPercent,
						windowMinutes: flag.windowMinutes,
					}),
				})
				.execute();
			return true;
		});
		if (written) {
			logger.info(
				{ workspaceId: id, averagePercent: flag.averagePercent },
				"memory flagged",
			);
		}
	}

	/** Make Incus hold the allowance the database says, or none (ADR 0032). */
	async function syncAllowance(
		id: string,
		inst: InstanceUsage,
		wanted: string | null,
	): Promise<void> {
		if (inst.cpuAllowance === wanted) {
			failures.delete(id);
			return;
		}
		try {
			await controller.setCpuAllowance(inst.name, wanted);
			failures.delete(id);
		} catch (e) {
			const errorCode =
				e instanceof ControllerClientError ? e.code : "OPERATION_FAILED";
			logger.warn({ workspaceId: id, errorCode }, "cpu allowance write failed");
			if (!(failures.has(id) && failures.get(id) === wanted)) {
				failures.set(id, wanted);
				await db
					.insertInto("audit_events")
					.values({
						actor: "worker",
						target: id,
						action: "workspace.cpu_throttle_failed",
						result: "failed",
						metadata: JSON.stringify({ errorCode, allowance: wanted }),
					})
					.execute();
			}
		}
	}
}

/** Run the guard now and then every GUARD_SAMPLE_SECONDS; returns a stop function. */
export function startGuard(options: GuardOptions): () => void {
	const tick = createGuard(options);
	const timer = setInterval(() => {
		void tick();
	}, GUARD_SAMPLE_SECONDS * 1000);
	// Leave Node's default signal handling in place, as the host sampler does.
	timer.unref();
	void tick();
	return () => clearInterval(timer);
}
