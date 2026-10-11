import {
	HealthSample,
	POOL_FULL_PERCENT,
	poolFillPercent,
	SeedImageList,
	seedImageListFor,
} from "@portikus/contracts";
import { type Database, isUniqueViolation, recordAudit } from "@portikus/db";
import { errorMessage, type Logger } from "@portikus/observability";
import type { Kysely } from "kysely";
import { insertJob, matchedImages, readMatch } from "./seed.js";

/** How often to look again while the image, the settings row or pool room is missing. */
const DEFAULT_SEED_RETRY_SECONDS = 60;

/**
 * Whether the newest host sample shows room for a seed at its size limit
 * without reaching the fill that refuses new workspaces. No sample yet
 * means no room known.
 */
async function poolHasRoom(db: Kysely<Database>, seedMaxGiB: number): Promise<boolean> {
	const newest = await db
		.selectFrom("health_samples")
		.select("sample")
		.orderBy("observed_at", "desc")
		.limit(1)
		.executeTakeFirst();
	const pool = HealthSample.safeParse(newest?.sample).data?.host?.pool;
	if (!pool) return false;
	const withSeed = { ...pool, usedBytes: pool.usedBytes + seedMaxGiB * 1024 ** 3 };
	return poolFillPercent(withSeed) < POOL_FULL_PERCENT;
}

/**
 * Write the default seed list on a new install and queue its first build
 * (SPEC.md section 16.6). Returns true once nothing is left to do: the
 * build is queued, or an administrator or an earlier build has taken over.
 */
export async function applyDefaultSeed(
	db: Kysely<Database>,
	imagesDir: string,
): Promise<boolean> {
	const settings = await db
		.selectFrom("settings")
		.select(["docker_ghcr_enabled", "docker_seed_images_set"])
		.where("id", "=", 1)
		.executeTakeFirst();
	// The worker inserts the row on its first start.
	if (!settings) return false;

	if (!settings.docker_seed_images_set) {
		const defaults = matchedImages(await readMatch(imagesDir));
		// The image manifest is outside the API, so its names get the same check as PUT.
		const valid = seedImageListFor(settings.docker_ghcr_enabled).safeParse(defaults);
		if (defaults.length === 0 || !valid.success) return false;
		await db.transaction().execute(async (tx) => {
			const applied = await tx
				.updateTable("settings")
				.set({
					docker_seed_images: JSON.stringify(defaults),
					docker_seed_images_set: true,
				})
				.where("id", "=", 1)
				.where("docker_seed_images_set", "=", false)
				.executeTakeFirst();
			if (Number(applied.numUpdatedRows) > 0) {
				await recordAudit(tx, {
					actor: "platform",
					target: "docker",
					action: "docker.seed_images_defaulted",
					result: "ok",
					metadata: { to: defaults },
				});
			}
		});
	}

	// Only the list the platform wrote, never one an administrator edited, and only once.
	const touched = await db
		.selectFrom("audit_events")
		.select("action")
		.where("target", "=", "docker")
		.where("action", "in", [
			"docker.seed_images_defaulted",
			"docker.seed_images_changed",
		])
		.execute();
	const defaulted = touched.some((a) => a.action === "docker.seed_images_defaulted");
	const edited = touched.some((a) => a.action === "docker.seed_images_changed");
	if (!defaulted || edited) return true;
	// The audit trail is append-only; job rows are pruned after 120 days.
	const requested = await db
		.selectFrom("audit_events")
		.select("id")
		.where("target", "=", "docker")
		.where("action", "=", "docker.seed_job_requested")
		.where("actor", "=", "platform")
		.executeTakeFirst();
	const seed = await db.selectFrom("docker_seed").select("images").executeTakeFirst();
	if (requested || seed) return true;

	const row = await db
		.selectFrom("settings")
		.select(["docker_seed_images", "docker_seed_max_gib"])
		.where("id", "=", 1)
		.executeTakeFirstOrThrow();
	const images = SeedImageList.safeParse(row.docker_seed_images).data ?? [];
	if (images.length === 0) return true;
	if (!(await poolHasRoom(db, row.docker_seed_max_gib))) return false;
	try {
		await db.transaction().execute(async (tx) => {
			const job = await insertJob(tx, images, null);
			await recordAudit(tx, {
				actor: "platform",
				target: "docker",
				action: "docker.seed_job_requested",
				result: "ok",
				metadata: { jobId: job.id, images: images.length },
			});
		});
	} catch (e) {
		if (!isUniqueViolation(e)) throw e;
	}
	return true;
}

/** Try at start, then every minute until done; errors are logged, never thrown. */
export function startDefaultSeed(options: {
	db: Kysely<Database>;
	logger: Logger;
	imagesDir: string;
}): () => void {
	const { db, logger, imagesDir } = options;
	let timer: NodeJS.Timeout | undefined;
	const tick = async (): Promise<void> => {
		try {
			if (await applyDefaultSeed(db, imagesDir)) clearInterval(timer);
		} catch (e) {
			logger.error({ error: errorMessage(e) }, "default seed error");
		}
	};
	timer = setInterval(() => void tick(), DEFAULT_SEED_RETRY_SECONDS * 1000);
	timer.unref();
	void tick();
	return () => clearInterval(timer);
}
