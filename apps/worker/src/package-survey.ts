import {
	type AddedPackagesResponse,
	PACKAGE_SURVEY_KEEP_DAYS,
} from "@portikus/contracts";
import type { Database } from "@portikus/db";
import { errorMessage, type Logger } from "@portikus/observability";
import { type Kysely, sql } from "kysely";
import { type ControllerClient, ControllerClientError } from "./controller-client.js";
import { startLoop } from "./loop.js";

/** How often the worker looks for a running workspace not yet surveyed today. */
const PACKAGE_SURVEY_SECONDS = 600;

export interface PackageSurveyOptions {
	db: Kysely<Database>;
	controller: ControllerClient;
	logger: Logger;
	now?: () => Date;
}

/** The UTC day of a moment, as `YYYY-MM-DD`. */
export function utcDay(at: Date): string {
	return at.toISOString().slice(0, 10);
}

/**
 * Build the tick of the package survey (SPEC.md §20.1, ADR 0042). Once per
 * UTC day for each running workspace, it reads the apt hook's list through
 * the controller and adds one to each listed package's count for the day.
 * Only counts are stored: the one per-workspace column is the day the
 * workspace was last surveyed, so no row ever pairs a workspace with a
 * package.
 *
 * A workspace with no readable list (an image without the hook, or a file
 * the controller refuses) is marked for the day but not counted. A failure
 * to reach the controller is retried on the next tick.
 */
export function createPackageSurvey(
	options: PackageSurveyOptions,
): () => Promise<void> {
	const { db, controller, logger } = options;
	const now = options.now ?? (() => new Date());

	return async function tick(): Promise<void> {
		try {
			const day = utcDay(now());
			const rows = await db
				.selectFrom("workspaces")
				.select(["id", "incus_instance_name"])
				.where("state", "=", "running")
				.where("incus_instance_name", "is not", null)
				.where((eb) =>
					eb.or([
						eb("package_surveyed_on", "is", null),
						eb("package_surveyed_on", "<", sql<Date>`${day}::date`),
					]),
				)
				.execute();

			for (const row of rows) {
				if (!row.incus_instance_name) continue;
				let list: AddedPackagesResponse | null;
				try {
					list = await controller.addedPackages(row.incus_instance_name);
					// No image header and no packages: the workspace has no list yet.
					if (list.image === null && list.packages.length === 0) list = null;
				} catch (e) {
					if (
						e instanceof ControllerClientError &&
						(e.code === "NOT_FOUND" || e.code === "BAD_REQUEST")
					) {
						list = null;
					} else {
						const errorCode =
							e instanceof ControllerClientError ? e.code : "OPERATION_FAILED";
						logger.warn(
							{ workspaceId: row.id, errorCode },
							"package survey read failed",
						);
						continue;
					}
				}
				await record(row.id, day, list);
			}

			await db
				.deleteFrom("package_survey_days")
				.where("day", "<", sql<Date>`${day}::date - ${PACKAGE_SURVEY_KEEP_DAYS}::int`)
				.execute();
		} catch (e) {
			logger.warn({ error: errorMessage(e) }, "package survey failed");
		}
	};

	/** Mark the workspace surveyed and, when it had a list, add its counts. */
	async function record(
		id: string,
		day: string,
		list: AddedPackagesResponse | null,
	): Promise<void> {
		await db.transaction().execute(async (trx) => {
			// The conditional update makes a second count of one workspace on one day impossible.
			const claimed = await trx
				.updateTable("workspaces")
				.set({ package_surveyed_on: day })
				.where("id", "=", id)
				.where((eb) =>
					eb.or([
						eb("package_surveyed_on", "is", null),
						eb("package_surveyed_on", "<", sql<Date>`${day}::date`),
					]),
				)
				.executeTakeFirst();
			if (Number(claimed.numUpdatedRows) === 0 || list === null) return;

			await trx
				.insertInto("package_survey_days")
				.values({ day, surveyed: 1 })
				.onConflict((oc) =>
					oc
						.column("day")
						.doUpdateSet({ surveyed: sql`package_survey_days.surveyed + 1` }),
				)
				.execute();
			const packages = [...new Set(list.packages)];
			if (packages.length === 0) return;
			await trx
				.insertInto("package_survey_counts")
				.values(packages.map((name) => ({ day, package: name, workspaces: 1 })))
				.onConflict((oc) =>
					oc
						.columns(["day", "package"])
						.doUpdateSet({ workspaces: sql`package_survey_counts.workspaces + 1` }),
				)
				.execute();
		});
	}
}

/** Run the survey now and then every PACKAGE_SURVEY_SECONDS; returns a stop function. */
export function startPackageSurvey(options: PackageSurveyOptions): () => void {
	const tick = createPackageSurvey(options);
	return startLoop(
		"package survey",
		options.logger,
		tick,
		PACKAGE_SURVEY_SECONDS * 1000,
	);
}
