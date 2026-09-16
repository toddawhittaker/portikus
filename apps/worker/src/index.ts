import { loadConfig, WorkerConfigSchema } from "@portikus/config";
import { createDb } from "@portikus/db";
import { HttpControllerClient } from "./controller-client.js";
import { reconcile, type SweepResult } from "./reconcile.js";

export const serviceName = "worker";

export function describeService(): string {
	return `portikus ${serviceName}`;
}

/** Start the reconcile loop; only runs when invoked as main. */
async function main(): Promise<void> {
	const config = loadConfig(WorkerConfigSchema);
	const db = createDb(config.DATABASE_URL);
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
