import { loadConfig, WorkerConfigSchema } from "@portikus/config";
import { createDb, type Database } from "@portikus/db";
import type { Kysely } from "kysely";
import { HttpControllerClient } from "./controller-client.js";
import { reconcile, type SweepResult } from "./reconcile.js";

export const serviceName = "worker";

export function describeService(): string {
	return `portikus ${serviceName}`;
}

/**
 * Put the platform-wide grace period in the database the first time the
 * worker runs (SPEC.md §6.4). Later starts leave the administrator's value
 * alone. Returns true when this call inserted the row.
 */
export async function seedSettings(
	db: Kysely<Database>,
	graceSeconds: number,
): Promise<boolean> {
	const result = await db
		.insertInto("settings")
		.values({ id: 1, shutdown_grace_seconds: graceSeconds })
		.onConflict((oc) => oc.doNothing())
		.executeTakeFirst();
	return Number(result?.numInsertedOrUpdatedRows ?? 0n) > 0;
}

/** Start the reconcile loop; only runs when invoked as main. */
async function main(): Promise<void> {
	const config = loadConfig(WorkerConfigSchema);
	const db = createDb(config.DATABASE_URL);
	if (await seedSettings(db, config.SHUTDOWN_GRACE_SECONDS)) {
		console.log(
			JSON.stringify({
				msg: "seeded platform settings",
				shutdownGraceSeconds: config.SHUTDOWN_GRACE_SECONDS,
			}),
		);
	}

	const controller = new HttpControllerClient(
		config.CONTROLLER_URL,
		config.CONTROLLER_TOKEN,
	);

	console.log(
		JSON.stringify({
			msg: `${describeService()} starting`,
			sweepInterval: config.SWEEP_INTERVAL_SECONDS,
		}),
	);

	let lastRefreshAt: Date | null = null;
	let controllerUnreachable = false;

	const loop = async (): Promise<void> => {
		try {
			const now = new Date();
			const result: SweepResult = await reconcile(
				db,
				controller,
				config,
				now,
				lastRefreshAt,
				controllerUnreachable,
			);
			lastRefreshAt = result.lastRefreshAt;
			controllerUnreachable = result.controllerUnreachable;
			if (result.refreshError) {
				console.error(
					JSON.stringify({
						msg: "controller status refresh failed",
						errorCode: result.refreshError.code,
					}),
				);
			}
			if (result.transitions > 0) {
				console.log(
					JSON.stringify({
						msg: "sweep",
						transitions: result.transitions,
					}),
				);
			}
		} catch (e) {
			console.error(
				JSON.stringify({
					msg: "sweep error",
					error: e instanceof Error ? e.message : String(e),
				}),
			);
		}
		setTimeout(loop, config.SWEEP_INTERVAL_SECONDS * 1000);
	};

	await loop();
}

if (process.argv[1]?.endsWith("index.ts") || process.argv[1]?.endsWith("index.js")) {
	main().catch((e) => {
		console.error(e);
		process.exit(1);
	});
}
