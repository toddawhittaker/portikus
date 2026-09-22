import { GrowVolumesRequest } from "@portikus/contracts";
import type { Database } from "@portikus/db";
import type { Logger } from "@portikus/observability";
import { type Kysely, sql } from "kysely";
import { type ControllerClient, ControllerClientError } from "./controller-client.js";

/** How often the worker looks for a quota an administrator changed. */
export const QUOTA_SYNC_SECONDS = 10;

/** How long a failed grow rests before the worker tries it again. */
export const QUOTA_RETRY_SECONDS = 300;

type Sizes = GrowVolumesRequest;

export interface QuotaSyncOptions {
	db: Kysely<Database>;
	controller: ControllerClient;
	logger: Logger;
	now?: () => Date;
}

async function audit(
	db: Kysely<Database>,
	target: string,
	action: string,
	result: string,
	metadata: Record<string, unknown>,
): Promise<void> {
	await db
		.insertInto("audit_events")
		.values({
			actor: "worker",
			target,
			action,
			result,
			metadata: JSON.stringify(metadata),
		})
		.execute();
}

/**
 * Build the tick that grows workspace volumes to the size an administrator
 * asked for (SPEC.md §20.1, ADR 0006). The API writes `quota_config`; this
 * compares it with `quota_applied`, asks the controller to grow, and records
 * the result. Growing works while the instance runs (Epic 11 task 2 spike),
 * so any state is applied except `provisioning`. A row whose instance was
 * never created has no image version and is skipped.
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
				.where(sql<boolean>`quota_config is distinct from quota_applied`)
				.execute();

			for (const row of rows) {
				const wanted = GrowVolumesRequest.safeParse(row.quota_config);
				if (!wanted.success || !row.incus_instance_name) continue;
				const key = JSON.stringify(wanted.data);
				const failed = failures.get(row.id);
				if (
					failed?.wanted === key &&
					now().getTime() - failed.at < QUOTA_RETRY_SECONDS * 1000
				) {
					continue;
				}
				await applyOne(row.id, row.incus_instance_name, wanted.data, row.quota_applied);
			}
		} catch (e) {
			logger.warn(
				{ error: e instanceof Error ? e.message : String(e) },
				"quota sync failed",
			);
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
		// A null means create made the volumes at quota_config: record it, grow nothing.
		if (applied === null) {
			await db
				.updateTable("workspaces")
				.set({ quota_applied: key })
				.where("id", "=", id)
				.where("quota_applied", "is", null)
				.where(sql<boolean>`quota_config = ${key}::jsonb`)
				.execute();
			return;
		}
		try {
			await controller.growVolumes(instance, wanted);
		} catch (e) {
			const errorCode =
				e instanceof ControllerClientError ? e.code : "OPERATION_FAILED";
			const previous = failures.get(id);
			failures.set(id, { wanted: key, at: now().getTime() });
			logger.warn({ workspaceId: id, errorCode }, "quota apply failed");
			if (previous?.wanted !== key) {
				await audit(db, id, "workspace.quota_apply_failed", "failed", {
					errorCode,
					to: wanted,
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
			.where(sql<boolean>`quota_config = ${key}::jsonb`)
			.executeTakeFirst();
		if (Number(updated.numUpdatedRows) === 0) return;

		logger.info({ workspaceId: id, ...wanted }, "quota applied");
		await audit(db, id, "workspace.quota_applied", "ok", { from: applied, to: wanted });
	}
}

/** Run the quota sync now and then every QUOTA_SYNC_SECONDS; returns a stop function. */
export function startQuotaSync(options: QuotaSyncOptions): () => void {
	const tick = createQuotaSync(options);
	const timer = setInterval(() => {
		void tick();
	}, QUOTA_SYNC_SECONDS * 1000);
	timer.unref();
	void tick();
	return () => clearInterval(timer);
}
