import { type GrowVolumesRequest, QuotaConfig } from "@portikus/contracts";
import { type Database, recordAudit } from "@portikus/db";
import { errorMessage, type Logger } from "@portikus/observability";
import { type Kysely, sql } from "kysely";
import { type ControllerClient, ControllerClientError } from "./controller-client.js";
import { startLoop } from "./loop.js";

/** How often the worker looks for a quota an administrator changed. */
const QUOTA_SYNC_SECONDS = 10;

/** How long a failed grow rests before the worker tries it again. */
export const QUOTA_RETRY_SECONDS = 300;

type Sizes = GrowVolumesRequest;

// Only the two grown volumes are compared; quota_config may hold other keys (such as recoveryGiB).
const wantedSizes = sql`jsonb_build_object('homeGiB', quota_config->'homeGiB', 'dockerGiB', quota_config->'dockerGiB')`;
const appliedSizes = sql`jsonb_build_object('homeGiB', quota_applied->'homeGiB', 'dockerGiB', quota_applied->'dockerGiB')`;

export interface QuotaSyncOptions {
	db: Kysely<Database>;
	controller: ControllerClient;
	logger: Logger;
	now?: () => Date;
}

// jscpd:ignore-start -- the limits and quota syncs share a shape but not their columns.
/**
 * Build the tick that grows workspace volumes to the size an administrator
 * asked for (SPEC.md §20.1, ADR 0006). The API writes `quota_config`; this
 * compares it with `quota_applied`, asks the controller to grow, and records
 * the result. Growing works while the instance runs,
 * so any state is applied except `provisioning`. A row whose instance was
 * never created has no image version and is skipped. Create records
 * quota_applied itself, so every row here already has one.
 *
 * A failure is audited once for each wanted size and retried after
 * QUOTA_RETRY_SECONDS, so a broken controller is not hammered.
 */
export function createQuotaSync(options: QuotaSyncOptions): () => Promise<void> {
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
				.select(["id", "incus_instance_name", "quota_config", "quota_applied"])
				.where("incus_instance_name", "is not", null)
				.where("image_version", "is not", null)
				.where("state", "<>", "provisioning")
				.where("quota_config", "is not", null)
				.where(
					sql<boolean>`${wantedSizes} is distinct from case when quota_applied is null then null else ${appliedSizes} end`,
				)
				.execute();

			for (const row of rows) {
				const parsed = QuotaConfig.safeParse(row.quota_config);
				if (!parsed.success || !row.incus_instance_name) continue;
				const wanted = {
					homeGiB: parsed.data.homeGiB,
					dockerGiB: parsed.data.dockerGiB,
				};
				const key = JSON.stringify(wanted);
				const failed = failures.get(row.id);
				if (
					failed?.wanted === key &&
					now().getTime() - failed.at < QUOTA_RETRY_SECONDS * 1000
				) {
					continue;
				}
				await applyOne(row.id, row.incus_instance_name, wanted, row.quota_applied);
			}
		} catch (e) {
			logger.warn({ error: errorMessage(e) }, "quota sync failed");
		} finally {
			inFlight = false;
		}
	};

	async function applyOne(
		id: string,
		instance: string,
		wanted: Sizes,
		applied: Sizes | null,
	): Promise<void> {
		const key = JSON.stringify(wanted);
		try {
			await controller.growVolumes(instance, wanted);
		} catch (e) {
			const errorCode =
				e instanceof ControllerClientError ? e.code : "OPERATION_FAILED";
			const previous = failures.get(id);
			failures.set(id, { wanted: key, at: now().getTime() });
			logger.warn({ workspaceId: id, errorCode }, "quota apply failed");
			if (previous?.wanted !== key) {
				await recordAudit(db, {
					actor: "worker",
					target: id,
					action: "workspace.quota_apply_failed",
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

		// Only record what was applied if nobody changed the wanted size meanwhile.
		const updated = await db
			.updateTable("workspaces")
			.set({ quota_applied: key })
			.where("id", "=", id)
			.where(sql<boolean>`${wantedSizes} = ${key}::jsonb`)
			.executeTakeFirst();
		if (Number(updated.numUpdatedRows) === 0) return;

		logger.info({ workspaceId: id, ...wanted }, "quota applied");
		await recordAudit(db, {
			actor: "worker",
			target: id,
			action: "workspace.quota_applied",
			result: "ok",
			metadata: { from: applied, to: wanted },
		});
	}
}
// jscpd:ignore-end

/** Run the quota sync now and then every QUOTA_SYNC_SECONDS; returns a stop function. */
export function startQuotaSync(options: QuotaSyncOptions): () => void {
	const tick = createQuotaSync(options);
	return startLoop(tick, QUOTA_SYNC_SECONDS * 1000);
}
