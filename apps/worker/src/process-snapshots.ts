import type { Database } from "@portikus/db";
import type { Logger } from "@portikus/observability";
import { type Kysely, sql } from "kysely";
import { type ControllerClient, ControllerClientError } from "./controller-client.js";

/** How often the worker looks for a pending Refresh (ADR 0037). */
export const PROCESS_SNAPSHOT_TICK_MS = 1000;

/** How long one controller read may take before it is recorded as a timeout. */
export const PROCESS_SNAPSHOT_TIMEOUT_MS = 10_000;

/** Snapshots older than this are deleted, with their process names. */
export const PROCESS_SNAPSHOT_MAX_AGE_MS = 60 * 60 * 1000;

/**
 * Serve every pending administrator Refresh once (ADR 0037): read the
 * processes from Incus through the controller, or record why not. Rows
 * older than an hour are deleted. Process names are never logged.
 */
export async function serveProcessSnapshots(
	db: Kysely<Database>,
	controller: ControllerClient,
	logger: Logger,
	now: () => Date = () => new Date(),
): Promise<number> {
	await db
		.deleteFrom("workspace_process_snapshots")
		.where("requested_at", "<", new Date(now().getTime() - PROCESS_SNAPSHOT_MAX_AGE_MS))
		.execute();

	const pending = await db
		.selectFrom("workspace_process_snapshots as s")
		.innerJoin("workspaces as w", "w.id", "s.workspace_id")
		.select(["s.workspace_id", "s.requested_at", "w.state", "w.incus_instance_name"])
		.where((eb) =>
			eb.or([
				eb("s.taken_at", "is", null),
				eb("s.taken_at", "<=", eb.ref("s.requested_at")),
			]),
		)
		.execute();

	for (const row of pending) {
		let processes: unknown = null;
		let error: string | null = null;
		if (row.state !== "running" || !row.incus_instance_name) {
			error = "WORKSPACE_NOT_RUNNING";
		} else {
			try {
				processes = await controller.processes(
					row.incus_instance_name,
					AbortSignal.timeout(PROCESS_SNAPSHOT_TIMEOUT_MS),
				);
			} catch (e) {
				error = e instanceof ControllerClientError ? e.code : "OPERATION_FAILED";
				logger.warn(
					{ workspaceId: row.workspace_id, errorCode: error },
					"process snapshot failed",
				);
			}
		}
		// Only the request that was served is answered; a newer Refresh stays pending.
		await db
			.updateTable("workspace_process_snapshots")
			.set({
				taken_at: now().toISOString(),
				processes: processes === null ? null : JSON.stringify(processes),
				error,
			})
			.where("workspace_id", "=", row.workspace_id)
			// A JavaScript Date holds milliseconds; the column may hold microseconds.
			.where(
				sql`date_trunc('milliseconds', requested_at)`,
				"=",
				row.requested_at.toISOString(),
			)
			.execute();
	}
	return pending.length;
}

/** Run the snapshot loop about once a second; errors are logged, never thrown. */
export function startProcessSnapshots(options: {
	db: Kysely<Database>;
	controller: ControllerClient;
	logger: Logger;
}): () => void {
	const { db, controller, logger } = options;
	let stopped = false;
	let timer: NodeJS.Timeout | undefined;
	const tick = async (): Promise<void> => {
		try {
			await serveProcessSnapshots(db, controller, logger);
		} catch (e) {
			logger.error(
				{ error: e instanceof Error ? e.message : String(e) },
				"process snapshot loop error",
			);
		}
		if (stopped) return;
		timer = setTimeout(() => void tick(), PROCESS_SNAPSHOT_TICK_MS);
		timer.unref();
	};
	void tick();
	return () => {
		stopped = true;
		clearTimeout(timer);
	};
}
