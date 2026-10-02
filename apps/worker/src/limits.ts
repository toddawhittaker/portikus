import { WorkspaceLimits } from "@portikus/contracts";
import { type Database, recordAudit } from "@portikus/db";
import { errorMessage, type Logger } from "@portikus/observability";
import { type Kysely, sql } from "kysely";
import { type ControllerClient, ControllerClientError } from "./controller-client.js";
import { startLoop } from "./loop.js";

/** How often the worker looks for limits an administrator changed. */
const LIMITS_SYNC_SECONDS = 10;

/** How long a failed limits write rests before the worker tries it again. */
export const LIMITS_RETRY_SECONDS = 300;

export interface LimitsSyncOptions {
	db: Kysely<Database>;
	controller: ControllerClient;
	logger: Logger;
	now?: () => Date;
}

/**
 * Build the tick that sets each workspace's own CPU, memory and process
 * limits on its instance (SPEC.md section 20.1). The API writes
 * `limits_config`; this compares it with `limits_applied`, asks the
 * controller to set the instance keys (a missing key removes the instance's
 * own value, so the profile applies), and records the result. Incus applies
 * the keys live to a running container, so any state is applied except
 * `provisioning` and `error`, where the instance may not exist yet.
 *
 * A failure is audited once for each wanted set and retried after
 * LIMITS_RETRY_SECONDS, so a broken controller is not hammered.
 */
export function createLimitsSync(options: LimitsSyncOptions): () => Promise<void> {
	const { db, controller, logger } = options;
	const now = options.now ?? (() => new Date());
	const failures = new Map<string, { wanted: string; at: number }>();
	let inFlight = false;

	return async function tick(): Promise<void> {
		if (inFlight) return;
		inFlight = true;
		try {
			const rows = await db
				.selectFrom("workspaces")
				.select(["id", "incus_instance_name", "limits_config", "limits_applied"])
				.where("incus_instance_name", "is not", null)
				.where("state", "not in", ["provisioning", "error"])
				.where(
					sql<boolean>`coalesce(limits_config, '{}'::jsonb) is distinct from coalesce(limits_applied, '{}'::jsonb)`,
				)
				.execute();

			for (const row of rows) {
				const parsed = WorkspaceLimits.safeParse(row.limits_config ?? {});
				if (!parsed.success || !row.incus_instance_name) continue;
				const key = JSON.stringify(parsed.data);
				const failed = failures.get(row.id);
				if (
					failed?.wanted === key &&
					now().getTime() - failed.at < LIMITS_RETRY_SECONDS * 1000
				) {
					continue;
				}
				await applyOne(
					row.id,
					row.incus_instance_name,
					parsed.data,
					row.limits_applied,
				);
			}
		} catch (e) {
			logger.warn({ error: errorMessage(e) }, "limits sync failed");
		} finally {
			inFlight = false;
		}
	};

	async function applyOne(
		id: string,
		instance: string,
		wanted: WorkspaceLimits,
		applied: WorkspaceLimits | null,
	): Promise<void> {
		const key = JSON.stringify(wanted);
		try {
			await controller.setLimits(instance, {
				cpu: wanted.cpu ?? null,
				memoryMiB: wanted.memoryMiB ?? null,
				processes: wanted.processes ?? null,
			});
		} catch (e) {
			const errorCode =
				e instanceof ControllerClientError ? e.code : "OPERATION_FAILED";
			const previous = failures.get(id);
			failures.set(id, { wanted: key, at: now().getTime() });
			logger.warn({ workspaceId: id, errorCode }, "limits apply failed");
			if (previous?.wanted !== key) {
				await recordAudit(db, {
					actor: "worker",
					target: id,
					action: "workspace.limits_apply_failed",
					result: "failed",
					metadata: {
						errorCode,
						to: wanted,
					},
				});
			}
			return;
		}
		failures.delete(id);

		// Only record what was applied if nobody changed the wanted limits meanwhile.
		const updated = await db
			.updateTable("workspaces")
			.set({ limits_applied: key })
			.where("id", "=", id)
			.where(sql<boolean>`coalesce(limits_config, '{}'::jsonb) = ${key}::jsonb`)
			.executeTakeFirst();
		if (Number(updated.numUpdatedRows) === 0) return;

		logger.info({ workspaceId: id, ...wanted }, "limits applied");
		await recordAudit(db, {
			actor: "worker",
			target: id,
			action: "workspace.limits_applied",
			result: "ok",
			metadata: {
				from: applied ?? {},
				to: wanted,
			},
		});
	}
}

/** Run the limits sync now and then every LIMITS_SYNC_SECONDS; returns a stop function. */
export function startLimitsSync(options: LimitsSyncOptions): () => void {
	const tick = createLimitsSync(options);
	return startLoop(tick, LIMITS_SYNC_SECONDS * 1000);
}
