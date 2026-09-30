import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { requireRole, requireUser } from "@portikus/auth";
import {
	canonicalImageName,
	type DockerAdminResponse,
	type DockerImageUsage,
	DockerSettingsRequest,
	type DockerUsageResponse,
	HubCredentialRequest,
	OTHER_IMAGES_LABEL,
	type RegistryJobRequest,
	type RegistryJobRequestFile,
	RegistryStatusFile,
	SeedImageList,
	SeedImagesRequest,
	type SeedJob,
	SeedJobState,
	seedImageListFor,
	USAGE_ROWS_MAX,
} from "@portikus/contracts";
import type { Database } from "@portikus/db";
import type { FastifyInstance, FastifyReply } from "fastify";
import { type Kysely, sql } from "kysely";
import type { ServerDeps } from "../server.js";
import { sendError } from "./project-scope.js";

const adminOnly = { preHandler: requireRole("administrator") };

/** The worker seeds the settings row on its first start. */
function notReady(reply: FastifyReply): void {
	sendError(reply, 404, "NOT_FOUND", "Platform settings are not set yet");
}

/** The usage report's window (issue #840). */
export const USAGE_WINDOW_DAYS = 30;
const SEED_JOBS_SHOWN = 10;

interface DockerSettings {
	ghcrEnabled: boolean;
	seedMaxGiB: number;
	seedImages: string[];
}

async function readSettings(db: Kysely<Database>): Promise<DockerSettings> {
	const row = await db
		.selectFrom("settings")
		.select(["docker_ghcr_enabled", "docker_seed_max_gib", "docker_seed_images"])
		.where("id", "=", 1)
		.executeTakeFirst();
	// The worker seeds the settings row; until then the column defaults apply.
	return {
		ghcrEnabled: row?.docker_ghcr_enabled ?? false,
		seedMaxGiB: row?.docker_seed_max_gib ?? 8,
		seedImages: SeedImageList.safeParse(row?.docker_seed_images).data ?? [],
	};
}

async function readStatus(file: string): Promise<RegistryStatusFile | null> {
	try {
		const parsed = RegistryStatusFile.safeParse(
			JSON.parse(await readFile(file, "utf8")),
		);
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
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

function jobView(row: {
	id: string;
	state: string;
	step: string;
	images: string[];
	message: string | null;
	requested_at: Date;
	finished_at: Date | null;
}): SeedJob {
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
 * Write one request for the root cache helper: aside, then renamed, so its
 * path unit never reads half a file. Mode 0600 because a credential request
 * carries the token (ruling S5).
 */
export async function writeRegistryRequest(
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
	const temp = join(dir, `.request-${id}.tmp`);
	try {
		await writeFile(temp, `${JSON.stringify(file)}\n`, { flag: "wx", mode: 0o600 });
		await rename(temp, join(dir, `request-${id}.json`));
	} catch (e) {
		await rm(temp, { force: true });
		throw e;
	}
	return id;
}

/**
 * The Docker admin tab's routes (issue #840): cache settings and the Hub
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
		await db
			.insertInto("audit_events")
			.values({
				actor: `user:${actor}`,
				target: "docker",
				action,
				result: "ok",
				metadata: JSON.stringify(metadata),
			})
			.execute();
	}

	app.get("/admin/docker", adminOnly, async (_request, reply) => {
		if (off(reply) || !jobsDir) return;
		const settings = await readSettings(db);
		const cache = await readStatus(join(jobsDir, "status.json"));
		const out: DockerAdminResponse = {
			cache,
			ghcrEnabled: settings.ghcrEnabled,
			seedMaxGiB: settings.seedMaxGiB,
			hubCredential: { isSet: cache?.hubCredentialSet ?? false },
			seedImages: settings.seedImages,
			seed: await readSeed(db),
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
		// a change that was rolled back. If this write fails the request
		// errors and the saved switch waits for the next change or reinstall.
		if (before.ghcrEnabled !== after.ghcrEnabled) {
			await writeRegistryRequest(jobsDir, admin.id, {
				kind: "set-ghcr",
				enabled: after.ghcrEnabled,
			});
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
			.set({ docker_seed_images: JSON.stringify(allowed.data) })
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
		const running = (): void =>
			sendError(
				reply,
				409,
				"SEED_JOB_RUNNING",
				"A seed rebuild is already waiting or running.",
			);
		let row: Parameters<typeof jobView>[0];
		try {
			row = await db
				.insertInto("docker_seed_jobs")
				.values({ images: JSON.stringify(seedImages), requested_by: admin.id })
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
		} catch (e) {
			// The partial unique index allows one queued or running job.
			if ((e as { code?: string }).code === "23505") return running();
			throw e;
		}
		await audit(admin.id, "docker.seed_job_requested", {
			jobId: row.id,
			images: seedImages.length,
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
		if (off(reply)) return;
		return reply
			.header("cache-control", "no-store")
			.send(await usageReport(db, new Date()));
	});
}

/**
 * The aggregate usage report (ruling 7, S7): images pulled or present that
 * the seed does not hold, and seed images no workspace used. Counts only;
 * no workspace id or owner leaves this function. Each list is cut to
 * USAGE_ROWS_MAX rows, most workspaces then most pulls first (ruling S7).
 */
export async function usageReport(
	db: Kysely<Database>,
	now: Date,
): Promise<DockerUsageResponse> {
	const since = new Date(now.getTime() - USAGE_WINDOW_DAYS * 86_400_000);
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
