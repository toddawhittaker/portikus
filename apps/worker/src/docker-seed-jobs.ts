import {
	SeedBuildRequest,
	type SeedBuildStatus,
	type SeedInfo,
} from "@portikus/contracts";
import { type Database, recordAudit } from "@portikus/db";
import { errorMessage, type Logger } from "@portikus/observability";
import type { Kysely } from "kysely";
import { type ControllerClient, ControllerClientError } from "./controller-client.js";
import { startLoop } from "./loop.js";

/** How often a running seed build is polled. */
const SEED_JOB_POLL_SECONDS = 5;
/** How often, with no build running, the seed row is checked against the controller. */
const SEED_SYNC_SECONDS = 60;

const GIB = 1024 ** 3;
// Controller answers that mean the request itself is wrong: retrying cannot help.
const REFUSALS = new Set(["BAD_REQUEST", "INVALID_NAME", "IMAGE_NOT_FOUND"]);

export interface SeedJobOptions {
	db: Kysely<Database>;
	controller: ControllerClient;
	logger: Logger;
	now?: () => Date;
}

/**
 * Build the tick that drives seed rebuilds. The API
 * inserts a `queued` row; this starts it on the controller with the seed
 * size cap as `maxBytes`, then polls it, copying state and step into the
 * row. On success it writes the `docker_seed` row. The row's id is the
 * build id, so a worker restart simply resumes polling; a controller that
 * no longer knows the id fails the job. With no build active it keeps the
 * `docker_seed` row equal to the controller's `GET /docker-seed`, removing
 * the row when the controller has no seed.
 */
export function createSeedJobs(options: SeedJobOptions): () => Promise<void> {
	const { db, controller, logger } = options;
	const now = options.now ?? (() => new Date());
	let inFlight = false;
	let lastSync: number | null = null;

	async function writeSeed(seed: SeedInfo): Promise<void> {
		const values = {
			images: JSON.stringify(seed.images),
			size_bytes: seed.sizeBytes,
			image_version: seed.imageVersion,
			built_at: seed.builtAt,
		};
		await db
			.insertInto("docker_seed")
			.values({ id: 1, ...values })
			.onConflict((oc) => oc.column("id").doUpdateSet(values))
			.execute();
	}

	async function syncSeed(): Promise<void> {
		const at = now().getTime();
		if (lastSync !== null && at - lastSync < SEED_SYNC_SECONDS * 1000) return;
		lastSync = at;
		let seed: SeedInfo | null;
		try {
			seed = await controller.seed();
		} catch (e) {
			logger.warn({ errorCode: codeOf(e) }, "seed check failed");
			return;
		}
		if (seed) await writeSeed(seed);
		else await db.deleteFrom("docker_seed").execute();
	}

	async function finish(
		id: string,
		state: "succeeded" | "failed",
		step: string,
		message: string | null,
	): Promise<void> {
		await db
			.updateTable("docker_seed_jobs")
			.set({ state, step, message, finished_at: now().toISOString() })
			.where("id", "=", id)
			.execute();
		await recordAudit(db, {
			actor: "worker",
			target: id,
			action: "docker.seed_job_finished",
			result: state === "succeeded" ? "ok" : "failed",
			metadata: { result: state },
		});
		logger.info({ jobId: id, result: state }, "seed build finished");
	}

	async function record(id: string, status: SeedBuildStatus): Promise<void> {
		const step = status.step.slice(0, 200);
		if (status.state === "running") {
			await db
				.updateTable("docker_seed_jobs")
				.set({ state: "running", step })
				.where("id", "=", id)
				.execute();
			return;
		}
		if (status.state === "failed") {
			await finish(id, "failed", step, status.message ?? "The seed build failed.");
			return;
		}
		const seed = status.seed;
		if (!seed) {
			await finish(id, "failed", step, "The controller reported no seed.");
			return;
		}
		await writeSeed(seed);
		await finish(id, "succeeded", step, null);
	}

	async function poll(id: string): Promise<void> {
		let status: SeedBuildStatus;
		try {
			status = await controller.seedBuild(id);
		} catch (e) {
			if (e instanceof ControllerClientError && e.code === "NOT_FOUND") {
				await finish(id, "failed", "Stopped", "The build was lost; start it again.");
				return;
			}
			logger.warn({ jobId: id, errorCode: codeOf(e) }, "seed build poll failed");
			return;
		}
		await record(id, status);
	}

	async function start(job: { id: string; images: string[] }): Promise<void> {
		const settings = await db
			.selectFrom("settings")
			.select(["docker_ghcr_enabled", "docker_seed_max_gib"])
			.where("id", "=", 1)
			.executeTakeFirst();
		const request = SeedBuildRequest.safeParse({
			id: job.id,
			images: job.images,
			ghcrEnabled: settings?.docker_ghcr_enabled ?? true,
			maxBytes: (settings?.docker_seed_max_gib ?? 8) * GIB,
		});
		if (!request.success) {
			await finish(job.id, "failed", "Refused", "The image list is not valid.");
			return;
		}
		try {
			await record(job.id, await controller.startSeedBuild(request.data));
		} catch (e) {
			if (e instanceof ControllerClientError && REFUSALS.has(e.code)) {
				await finish(job.id, "failed", "Refused", e.message.slice(0, 1000));
				return;
			}
			logger.warn({ jobId: job.id, errorCode: codeOf(e) }, "seed build start failed");
			// The start may have reached the controller before the answer was lost.
			try {
				await record(job.id, await controller.seedBuild(job.id));
			} catch {
				// Still queued; the next tick tries again.
			}
		}
	}

	return async function tick(): Promise<void> {
		if (inFlight) return;
		inFlight = true;
		try {
			const job = await db
				.selectFrom("docker_seed_jobs")
				.select(["id", "state", "images"])
				.where("state", "in", ["queued", "running"])
				.orderBy("requested_at")
				.executeTakeFirst();
			if (!job) {
				await syncSeed();
				return;
			}
			if (job.state === "running") await poll(job.id);
			else await start(job);
		} catch (e) {
			logger.warn({ error: errorMessage(e) }, "seed jobs failed");
		} finally {
			inFlight = false;
		}
	};
}

function codeOf(e: unknown): string {
	return e instanceof ControllerClientError ? e.code : "OPERATION_FAILED";
}

/** Run the seed job tick every SEED_JOB_POLL_SECONDS; returns a stop function. */
export function startSeedJobs(options: SeedJobOptions): () => void {
	const tick = createSeedJobs(options);
	return startLoop(tick, SEED_JOB_POLL_SECONDS * 1000);
}
