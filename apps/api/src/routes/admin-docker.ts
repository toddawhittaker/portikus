import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { requireRole, requireUser } from "@portikus/auth";
import {
	canonicalImageName,
	type DockerAdminResponse,
	type DockerCacheStatus,
	type DockerImageUsage,
	DockerSettingsRequest,
	type DockerUsageResponse,
	HubCredentialRequest,
	ImageAliasesFile,
	ImageManifest,
	matchingSeedImages,
	OTHER_IMAGES_LABEL,
	overSeedCap,
	type RegistryJobRequest,
	type RegistryJobRequestFile,
	RegistryStatusFile,
	SeedImageList,
	SeedImagesRequest,
	type SeedJob,
	SeedJobState,
	type SeedMatch,
	seedDrift,
	seedImageListFor,
	USAGE_ROWS_MAX,
	USAGE_WINDOW_DAYS,
} from "@portikus/contracts";
import { type Database, isUniqueViolation, recordAudit } from "@portikus/db";
import type { FastifyInstance, FastifyReply } from "fastify";
import { type Kysely, sql } from "kysely";
import type { ServerDeps } from "../deps.js";
import { sendError } from "../http.js";
import { imagesDirOf } from "../image/release-notices.js";
import { readJson, writeRequestFile } from "../job-files.js";

const adminOnly = { preHandler: requireRole("administrator") };

/** The worker seeds the settings row on its first start. */
function notReady(reply: FastifyReply): FastifyReply {
	return sendError(reply, 404, "NOT_FOUND", "Platform settings are not set yet");
}

const SEED_JOBS_SHOWN = 10;

interface DockerSettings {
	ghcrEnabled: boolean;
	seedMaxGiB: number;
	seedImages: string[];
	/** False until an administrator first saves the list. */
	seedImagesSet: boolean;
}

async function readSettings(db: Kysely<Database>): Promise<DockerSettings> {
	const row = await db
		.selectFrom("settings")
		.select([
			"docker_ghcr_enabled",
			"docker_seed_max_gib",
			"docker_seed_images",
			"docker_seed_images_set",
		])
		.where("id", "=", 1)
		.executeTakeFirst();
	// The worker seeds the settings row; until then the column defaults apply.
	return {
		ghcrEnabled: row?.docker_ghcr_enabled ?? true,
		seedMaxGiB: row?.docker_seed_max_gib ?? 8,
		seedImages: SeedImageList.safeParse(row?.docker_seed_images).data ?? [],
		seedImagesSet: row?.docker_seed_images_set ?? false,
	};
}

/** The slim images matching the default workspace image, or null when its manifest is unreadable. */
async function readMatch(imagesDir: string | null): Promise<SeedMatch | null> {
	if (!imagesDir) return null;
	const aliases = await readJson(join(imagesDir, "aliases.json"), ImageAliasesFile);
	if (!aliases?.default) return null;
	const manifest = await readJson(
		join(imagesDir, aliases.default, "manifest.json"),
		ImageManifest,
	);
	return manifest ? matchingSeedImages(manifest) : null;
}

function matchedImages(match: SeedMatch | null): string[] {
	return [match?.node?.image, match?.python?.image].filter(
		(each): each is string => each !== undefined,
	);
}

type ImageSizes = NonNullable<RegistryStatusFile["imageSizes"]>;

/** The page's view of the status: everything but the size list. */
function cacheView(status: RegistryStatusFile | null): DockerCacheStatus | null {
	if (!status) return null;
	const { imageSizes: _sizes, ...cache } = status;
	return cache;
}

/** Download sizes of the named images, keyed as the page looks them up. */
function sizesOf(names: string[], sizes: ImageSizes): Record<string, number> {
	const out: Record<string, number> = {};
	for (const name of names) {
		const key = canonicalImageName(name);
		const entry = sizes[key];
		if (entry) out[key] = entry.bytes;
	}
	return out;
}

async function readSeed(db: Kysely<Database>): Promise<DockerAdminResponse["seed"]> {
	const row = await db.selectFrom("docker_seed").selectAll().executeTakeFirst();
	if (!row) return null;
	return {
		images: row.images,
		sizeBytes: Number(row.size_bytes),
		imageVersion: row.image_version,
		builtAt: row.built_at.toISOString(),
	};
}

interface JobRow {
	id: string;
	state: string;
	step: string;
	images: string[];
	message: string | null;
	requested_at: Date;
	finished_at: Date | null;
}

function insertJob(
	db: Kysely<Database>,
	images: string[],
	requestedBy: string,
): Promise<JobRow> {
	return db
		.insertInto("docker_seed_jobs")
		.values({ images: JSON.stringify(images), requested_by: requestedBy })
		.returning([
			"id",
			"state",
			"step",
			"images",
			"message",
			"requested_at",
			"finished_at",
		])
		.executeTakeFirstOrThrow();
}

function jobRunning(reply: FastifyReply): FastifyReply {
	return sendError(
		reply,
		409,
		"SEED_JOB_RUNNING",
		"A seed rebuild is already waiting or running.",
	);
}

function jobView(row: JobRow): SeedJob {
	return {
		id: row.id,
		state: SeedJobState.parse(row.state),
		step: row.step,
		images: row.images,
		message: row.message,
		requestedAt: row.requested_at.toISOString(),
		finishedAt: row.finished_at?.toISOString() ?? null,
	};
}

/**
 * Write one request for the root cache helper. Mode 0600 because a
 * credential request carries the token.
 */
async function writeRegistryRequest(
	dir: string,
	requestedBy: string,
	request: RegistryJobRequest,
): Promise<string> {
	const id = randomUUID();
	const file: RegistryJobRequestFile = {
		id,
		requestedAt: new Date().toISOString(),
		requestedBy,
		request,
	};
	await writeRequestFile(dir, file, 0o600);
	return id;
}

/**
 * The Docker admin tab's routes: cache settings and the Hub
 * credential through the root helper's request files, the seed list and
 * rebuild jobs through the database and the worker, and the aggregate usage
 * report. Every change writes an audit row, and none carries the token.
 * With REGISTRY_JOBS_DIR unset every route is 404.
 */
export function registerAdminDockerRoutes(
	app: FastifyInstance,
	{ db, config }: ServerDeps,
): void {
	const jobsDir = config.REGISTRY_JOBS_DIR;
	const imagesDir = config.IMAGE_JOBS_DIR ? imagesDirOf(config.IMAGE_JOBS_DIR) : null;

	function off(reply: FastifyReply): boolean {
		if (jobsDir) return false;
		sendError(reply, 404, "NOT_FOUND", "Not found.");
		return true;
	}

	async function audit(
		actor: string,
		action: string,
		metadata: Record<string, unknown>,
	): Promise<void> {
		await recordAudit(db, {
			actor: `user:${actor}`,
			target: "docker",
			action,
			result: "ok",
			metadata: metadata,
		});
	}

	app.get("/admin/docker", adminOnly, async (_request, reply) => {
		if (off(reply) || !jobsDir) return;
		const match = await readMatch(imagesDir);
		let settings = await readSettings(db);
		const defaults = matchedImages(match);
		// The image manifest is outside the API, so its names get the same check as PUT.
		const defaultsValid = seedImageListFor(settings.ghcrEnabled).safeParse(
			defaults,
		).success;
		if (
			!settings.seedImagesSet &&
			settings.seedImages.length === 0 &&
			defaults.length > 0 &&
			defaultsValid
		) {
			// The default seed for a list no administrator has set.
			const applied = await db
				.updateTable("settings")
				.set({
					docker_seed_images: JSON.stringify(defaults),
					docker_seed_images_set: true,
				})
				.where("id", "=", 1)
				.where("docker_seed_images_set", "=", false)
				.executeTakeFirst();
			if (Number(applied.numUpdatedRows) > 0) {
				await recordAudit(db, {
					actor: "platform",
					target: "docker",
					action: "docker.seed_images_defaulted",
					result: "ok",
					metadata: { to: defaults },
				});
			}
			settings = await readSettings(db);
		}
		const status = await readJson(join(jobsDir, "status.json"), RegistryStatusFile);
		const seed = await readSeed(db);
		const out: DockerAdminResponse = {
			cache: cacheView(status),
			ghcrEnabled: settings.ghcrEnabled,
			seedMaxGiB: settings.seedMaxGiB,
			hubCredential: { isSet: status?.hubCredentialSet ?? false },
			seedImages: settings.seedImages,
			seed,
			imageSizes: sizesOf(
				[...settings.seedImages, ...(seed?.images ?? []), ...defaults],
				status?.imageSizes ?? {},
			),
			match,
		};
		return reply.header("cache-control", "no-store").send(out);
	});

	app.put("/admin/docker/settings", adminOnly, async (request, reply) => {
		if (off(reply) || !jobsDir) return;
		const admin = requireUser(request);
		const body = DockerSettingsRequest.safeParse(request.body);
		if (!body.success) {
			return sendError(reply, 400, "VALIDATION_FAILED", "Invalid Docker settings.");
		}
		const before = await readSettings(db);
		const after = {
			ghcrEnabled: body.data.ghcrEnabled ?? before.ghcrEnabled,
			seedMaxGiB: body.data.seedMaxGiB ?? before.seedMaxGiB,
		};
		const updated = await db
			.updateTable("settings")
			.set({
				docker_ghcr_enabled: after.ghcrEnabled,
				docker_seed_max_gib: after.seedMaxGiB,
			})
			.where("id", "=", 1)
			.executeTakeFirst();
		if (Number(updated.numUpdatedRows) === 0) return notReady(reply);
		// Written only once the switch is saved, so the helper never acts on
		// a change that was rolled back. If this write fails the switch goes
		// back, so the page never shows a state the helper was not asked for.
		if (before.ghcrEnabled !== after.ghcrEnabled) {
			try {
				await writeRegistryRequest(jobsDir, admin.id, {
					kind: "set-ghcr",
					enabled: after.ghcrEnabled,
				});
			} catch (error) {
				await db
					.updateTable("settings")
					.set({ docker_ghcr_enabled: before.ghcrEnabled })
					.where("id", "=", 1)
					.execute();
				throw error;
			}
		}
		await audit(admin.id, "docker.settings_changed", {
			from: { ghcrEnabled: before.ghcrEnabled, seedMaxGiB: before.seedMaxGiB },
			to: after,
		});
		return reply.status(204).send();
	});

	app.put("/admin/docker/hub-credential", adminOnly, async (request, reply) => {
		if (off(reply) || !jobsDir) return;
		const admin = requireUser(request);
		const body = HubCredentialRequest.safeParse(request.body);
		if (!body.success) {
			// Never echo the body: it may hold the token.
			return sendError(
				reply,
				400,
				"VALIDATION_FAILED",
				"Enter a Docker Hub username and access token.",
			);
		}
		await writeRegistryRequest(jobsDir, admin.id, {
			kind: "set-hub-credential",
			username: body.data.username,
			token: body.data.token,
		});
		await audit(admin.id, "docker.hub_credential", { change: "set" });
		return reply.status(204).send();
	});

	app.delete("/admin/docker/hub-credential", adminOnly, async (request, reply) => {
		if (off(reply) || !jobsDir) return;
		const admin = requireUser(request);
		await writeRegistryRequest(jobsDir, admin.id, { kind: "remove-hub-credential" });
		await audit(admin.id, "docker.hub_credential", { change: "cleared" });
		return reply.status(204).send();
	});

	app.post("/admin/docker/cache/clear", adminOnly, async (request, reply) => {
		if (off(reply) || !jobsDir) return;
		const admin = requireUser(request);
		// The helper would do nothing and the page would say it cleared.
		// No cache, so nothing to clear: 404 rather than a new error code.
		if ((await readJson(join(jobsDir, "status.json"), RegistryStatusFile))?.cacheOff) {
			return sendError(
				reply,
				404,
				"NOT_FOUND",
				"The pull cache is off, so there is nothing to clear.",
			);
		}
		const id = await writeRegistryRequest(jobsDir, admin.id, { kind: "clear" });
		await audit(admin.id, "docker.cache_clear_requested", { requestId: id });
		return reply.status(202).send();
	});

	app.put("/admin/docker/seed/images", adminOnly, async (request, reply) => {
		if (off(reply)) return;
		const admin = requireUser(request);
		const body = SeedImagesRequest.safeParse(request.body);
		if (!body.success) {
			return sendError(
				reply,
				400,
				"VALIDATION_FAILED",
				body.error.issues[0]?.message ?? "Invalid image list.",
			);
		}
		const { ghcrEnabled, seedImages } = await readSettings(db);
		const allowed = seedImageListFor(ghcrEnabled).safeParse(body.data.images);
		if (!allowed.success) {
			return sendError(
				reply,
				400,
				"VALIDATION_FAILED",
				allowed.error.issues[0]?.message ?? "Invalid image list.",
			);
		}
		const updated = await db
			.updateTable("settings")
			.set({
				docker_seed_images: JSON.stringify(allowed.data),
				docker_seed_images_set: true,
			})
			.where("id", "=", 1)
			.executeTakeFirst();
		if (Number(updated.numUpdatedRows) === 0) return notReady(reply);
		await audit(admin.id, "docker.seed_images_changed", {
			from: seedImages,
			to: allowed.data,
		});
		return reply.status(204).send();
	});

	app.post("/admin/docker/seed/jobs", adminOnly, async (request, reply) => {
		if (off(reply)) return;
		const admin = requireUser(request);
		const { seedImages } = await readSettings(db);
		if (seedImages.length === 0) {
			return sendError(
				reply,
				409,
				"SEED_LIST_EMPTY",
				"Add at least one image before rebuilding the seed.",
			);
		}
		let row: JobRow;
		try {
			row = await insertJob(db, seedImages, admin.id);
		} catch (e) {
			if (isUniqueViolation(e)) return jobRunning(reply);
			throw e;
		}
		await audit(admin.id, "docker.seed_job_requested", {
			jobId: row.id,
			images: seedImages.length,
		});
		return reply.status(202).send(jobView(row));
	});

	// The drift notice's button: swap the old matched tags for the
	// default image's, then rebuild, both or neither.
	app.post("/admin/docker/seed/match", adminOnly, async (request, reply) => {
		if (off(reply) || !jobsDir) return;
		const admin = requireUser(request);
		const match = await readMatch(imagesDir);
		if (!match) {
			return sendError(
				reply,
				404,
				"NOT_FOUND",
				"The default workspace image's versions are not known.",
			);
		}
		const { ghcrEnabled, seedImages, seedMaxGiB } = await readSettings(db);
		const drift = seedDrift(seedImages, match);
		if (!drift) {
			return sendError(
				reply,
				400,
				"VALIDATION_FAILED",
				"The seed list already holds the images that match the workspace image.",
			);
		}
		const status = await readJson(join(jobsDir, "status.json"), RegistryStatusFile);
		const sizes = sizesOf(drift.next, status?.imageSizes ?? {});
		if (overSeedCap(drift.next, sizes, seedMaxGiB)) {
			return sendError(
				reply,
				400,
				"VALIDATION_FAILED",
				"The matching images would push the seed past its size limit, by estimated download size.",
			);
		}
		const allowed = seedImageListFor(ghcrEnabled).safeParse(drift.next);
		if (!allowed.success) {
			return sendError(
				reply,
				400,
				"VALIDATION_FAILED",
				allowed.error.issues[0]?.message ?? "Invalid image list.",
			);
		}
		let row: JobRow;
		try {
			row = await db.transaction().execute(async (trx) => {
				await trx
					.updateTable("settings")
					.set({
						docker_seed_images: JSON.stringify(allowed.data),
						docker_seed_images_set: true,
					})
					.where("id", "=", 1)
					.execute();
				return insertJob(trx, allowed.data, admin.id);
			});
		} catch (e) {
			if (isUniqueViolation(e)) return jobRunning(reply);
			throw e;
		}
		await audit(admin.id, "docker.seed_images_changed", {
			from: seedImages,
			to: allowed.data,
			reason: "match-image",
		});
		await audit(admin.id, "docker.seed_job_requested", {
			jobId: row.id,
			images: allowed.data.length,
		});
		return reply.status(202).send(jobView(row));
	});

	app.get("/admin/docker/seed/jobs", adminOnly, async (_request, reply) => {
		if (off(reply)) return;
		const rows = await db
			.selectFrom("docker_seed_jobs")
			.select([
				"id",
				"state",
				"step",
				"images",
				"message",
				"requested_at",
				"finished_at",
			])
			.orderBy("requested_at", "desc")
			.limit(SEED_JOBS_SHOWN)
			.execute();
		return reply.header("cache-control", "no-store").send({ jobs: rows.map(jobView) });
	});

	app.get("/admin/docker/usage", adminOnly, async (_request, reply) => {
		if (off(reply) || !jobsDir) return;
		const status = await readJson(join(jobsDir, "status.json"), RegistryStatusFile);
		return reply
			.header("cache-control", "no-store")
			.send(await usageReport(db, new Date(), status?.imageSizes));
	});
}

/**
 * The first moment of the usage window: midnight UTC at the start of the
 * oldest of USAGE_WINDOW_DAYS calendar days, today included. Pulls are kept
 * by UTC day, so a cut-off mid-day would count one day more.
 */
export function usageWindowStart(now: Date): Date {
	return new Date(
		Date.UTC(
			now.getUTCFullYear(),
			now.getUTCMonth(),
			now.getUTCDate() - (USAGE_WINDOW_DAYS - 1),
		),
	);
}

/**
 * The aggregate usage report: images pulled or present that
 * the seed does not hold, and seed images no workspace used. Counts only;
 * no workspace id or owner leaves this function. Each list is cut to
 * USAGE_ROWS_MAX rows, most workspaces then most pulls first.
 */
export async function usageReport(
	db: Kysely<Database>,
	now: Date,
	sizes: ImageSizes = {},
): Promise<DockerUsageResponse> {
	const since = usageWindowStart(now);
	const sinceDay = since.toISOString().slice(0, 10);
	const seed = await readSeed(db);
	const seedNames = new Set((seed?.images ?? []).map(canonicalImageName));

	const pulls = await db
		.selectFrom("docker_image_pulls")
		.select(["image", "workspace_id", "pulls", "last_seen"])
		.where("day", ">=", sql<Date>`${sinceDay}::date`)
		.execute();
	const present = await db
		.selectFrom("docker_image_presence")
		.select(["image", "workspace_id", "in_seed", "used", "sampled_at"])
		.where("sampled_at", ">=", since)
		.execute();

	interface Tally {
		pulls: number;
		workspaces: Set<string>;
		lastSeen: Date | null;
	}
	const tallies = new Map<string, Tally>();
	const tallyOf = (image: string): Tally => {
		let t = tallies.get(image);
		if (!t) {
			t = { pulls: 0, workspaces: new Set(), lastSeen: null };
			tallies.set(image, t);
		}
		return t;
	};
	const seen = (t: Tally, at: Date): void => {
		if (!t.lastSeen || at > t.lastSeen) t.lastSeen = at;
	};
	for (const p of pulls) {
		const t = tallyOf(p.image);
		t.pulls += p.pulls;
		t.workspaces.add(p.workspace_id);
		seen(t, p.last_seen);
	}
	for (const p of present) {
		if (p.in_seed) continue;
		const t = tallyOf(p.image);
		t.workspaces.add(p.workspace_id);
		seen(t, p.sampled_at);
	}
	const toUsage = (image: string, t: Tally): DockerImageUsage => ({
		image,
		pulls: t.pulls,
		workspaces: t.workspaces.size,
		lastSeen: t.lastSeen?.toISOString() ?? null,
		// Names here are canonical already; other registries' names are never in the cache.
		downloadBytes: sizes[image]?.bytes ?? null,
	});
	const byUse = (a: DockerImageUsage, b: DockerImageUsage): number =>
		b.workspaces - a.workspaces ||
		b.pulls - a.pulls ||
		// "(other images)" last among equals, then by name.
		Number(a.image === OTHER_IMAGES_LABEL) - Number(b.image === OTHER_IMAGES_LABEL) ||
		a.image.localeCompare(b.image);
	const notInSeed = [...tallies]
		.filter(([image]) => !seedNames.has(image))
		.map(([image, t]) => toUsage(image, t))
		.sort(byUse);

	const unusedSeed: DockerImageUsage[] = [];
	for (const image of seedNames) {
		const rows = present.filter((p) => p.image === image);
		if (rows.some((p) => p.used)) continue;
		const t: Tally = { pulls: 0, workspaces: new Set(), lastSeen: null };
		for (const p of rows) {
			t.workspaces.add(p.workspace_id);
			seen(t, p.sampled_at);
		}
		unusedSeed.push(toUsage(image, t));
	}
	unusedSeed.sort(byUse);
	return {
		windowDays: USAGE_WINDOW_DAYS,
		notInSeed: notInSeed.slice(0, USAGE_ROWS_MAX),
		notInSeedTotal: notInSeed.length,
		unusedSeed: unusedSeed.slice(0, USAGE_ROWS_MAX),
		unusedSeedTotal: unusedSeed.length,
	};
}
