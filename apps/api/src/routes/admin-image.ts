import { randomUUID } from "node:crypto";
import { statfs } from "node:fs/promises";
import { join } from "node:path";
import { requireRole, requireUser } from "@portikus/auth";
import {
	type AdminImage,
	type ApiError,
	IMAGE_JOB_STALE_MS,
	IMAGE_LOG_LINES,
	ImageAliasesFile,
	ImageDiffQuery,
	ImageHealth,
	ImageJobId,
	ImageJobRequest,
	ImageJobRequestFile,
	ImageJobStatusFile,
	type ImageJobView,
	ImageManifest,
	ImageSizeFile,
	ImageVersion,
	type ImageView,
	isJobActive,
	newerPublishedImage,
} from "@portikus/contracts";
import { recordAudit } from "@portikus/db";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { ServerDeps } from "../deps.js";
import { sendError } from "../http.js";
import { diffManifests } from "../image/manifest-diff.js";
import { imagesDirOf, readPublished } from "../image/release-notices.js";
import {
	currentJob,
	listDir,
	readJson,
	tailLines,
	writeRequestFile,
} from "../job-files.js";

/** The disk the image store is on, which also holds Incus's image files on a standard install. */
async function diskOf(path: string): Promise<AdminImage["disk"]> {
	try {
		const stat = await statfs(path);
		return {
			freeBytes: stat.bavail * stat.bsize,
			totalBytes: stat.blocks * stat.bsize,
		};
	} catch {
		return null;
	}
}

const adminOnly = { preHandler: requireRole("administrator") };
const REQUEST_FILE = /^request-([0-9a-f-]{36})\.json$/;

/** A request the job has not taken yet. */
function queuedView(file: ImageJobRequestFile): ImageJobView {
	return {
		id: file.id,
		kind: file.request.kind,
		state: "queued",
		step: "Waiting to start",
		version: "version" in file.request ? (file.request.version ?? null) : null,
		message: null,
		requestedAt: file.requestedAt,
		startedAt: null,
		finishedAt: null,
		request: file.request,
	};
}

function summarize(manifest: ImageManifest | null): ImageView["manifest"] {
	if (!manifest) return null;
	const { packages, ...rest } = manifest;
	return { ...rest, packageCount: Object.keys(packages).length };
}

function isFinished(job: ImageJobView): boolean {
	return job.state === "succeeded" || job.state === "failed" || job.state === "refused";
}

/**
 * The Workspace image section (docs/SPEC.md section 22.4; ADR 0030).
 * The API reads what the root job writes and writes nothing but one request
 * file into IMAGE_JOBS_DIR. With IMAGE_JOBS_DIR unset every route is 404.
 */
export function registerAdminImageRoutes(
	app: FastifyInstance,
	{ db, config }: ServerDeps,
): void {
	const jobsDir = config.IMAGE_JOBS_DIR;
	const imagesDir = jobsDir ? imagesDirOf(jobsDir) : null;
	// One API process: this closes the gap between checking and writing.
	let writing = false;

	function off(reply: FastifyReply): boolean {
		if (jobsDir) return false;
		sendError(reply, 404, "NOT_FOUND", "Not found.");
		return true;
	}

	async function queuedJobs(dir: string): Promise<ImageJobView[]> {
		const jobs: ImageJobView[] = [];
		for (const name of await listDir(dir)) {
			if (!REQUEST_FILE.test(name)) continue;
			const file = await readJson(join(dir, name), ImageJobRequestFile);
			if (!file) continue;
			jobs.push(queuedView(file));
		}
		return jobs;
	}

	async function readJob(dir: string, id: string): Promise<ImageJobView | null> {
		const status = await readJson(join(dir, id, "status.json"), ImageJobStatusFile);
		const request = await readJson(join(dir, id, "request.json"), ImageJobRequestFile);
		// The job moves the request in before it writes its first status: still waiting.
		if (!status) return request && request.id === id ? queuedView(request) : null;
		if (status.id !== id) return null;
		return {
			id,
			kind: status.kind,
			state: status.state,
			step: status.step,
			version: status.version,
			message: status.message,
			requestedAt: request?.requestedAt ?? null,
			startedAt: status.startedAt,
			finishedAt: status.finishedAt,
			request: request?.request ?? null,
		};
	}

	async function allJobs(dir: string): Promise<ImageJobView[]> {
		const jobs = await queuedJobs(dir);
		for (const name of await listDir(dir)) {
			if (!ImageJobId.safeParse(name).success) continue;
			const job = await readJob(dir, name);
			if (job) jobs.push(job);
		}
		return jobs;
	}

	/** Write image.job_finished the first time the API sees a job finished. */
	async function noteFinished(job: ImageJobView): Promise<void> {
		if (!isFinished(job)) return;
		const seen = await db
			.selectFrom("audit_events")
			.select("id")
			.where("action", "=", "image.job_finished")
			.where("target", "=", job.id)
			.executeTakeFirst();
		if (seen) return;
		await recordAudit(db, {
			actor: "image-job",
			target: job.id,
			action: "image.job_finished",
			result: job.state === "succeeded" ? "ok" : "failed",
			metadata: {
				kind: job.kind,
				result: job.state,
				version: job.version,
			},
		});
	}

	async function readStore(store: string) {
		const aliases = (await readJson(join(store, "aliases.json"), ImageAliasesFile)) ?? {
			default: null,
			previous: null,
		};
		const versions = (await listDir(store)).filter(
			(name) => ImageVersion.safeParse(name).success,
		);
		const images = await Promise.all(
			versions.map(async (version) => ({
				version,
				manifest: await readJson(join(store, version, "manifest.json"), ImageManifest),
				health: await readJson(join(store, version, "health.json"), ImageHealth),
				size: await readJson(join(store, version, "size.json"), ImageSizeFile),
			})),
		);
		return { aliases, images };
	}

	app.get("/admin/image", adminOnly, async (_request, reply) => {
		if (off(reply) || !jobsDir || !imagesDir) return;
		// Jobs first: the root job moves the aliases before it writes "succeeded",
		// so a finished job is never paired with the aliases from before it.
		const job = currentJob(await allJobs(jobsDir), IMAGE_JOB_STALE_MS);
		const { aliases, images } = await readStore(imagesDir);
		const counts = await db
			.selectFrom("workspaces")
			.select(["image_version"])
			.select((eb) => eb.fn.countAll<string>().as("count"))
			.groupBy("image_version")
			.execute();
		const byFingerprint = new Map(
			counts.map((row) => [row.image_version ?? "", Number(row.count)]),
		);
		let counted = 0;
		const views: ImageView[] = images.map(({ version, manifest, health, size }) => {
			const fingerprint = manifest?.fingerprint ?? null;
			const workspaces = fingerprint ? (byFingerprint.get(fingerprint) ?? 0) : 0;
			counted += workspaces;
			return {
				version,
				role:
					version === aliases.default
						? "default"
						: version === aliases.previous
							? "previous"
							: "candidate",
				manifest: summarize(manifest),
				health,
				workspaces,
				sizeBytes: size?.bytes ?? null,
			};
		});
		const rank = { default: 0, previous: 1, candidate: 2 };
		views.sort(
			(a, b) =>
				rank[a.role] - rank[b.role] ||
				b.version.localeCompare(a.version, "en", { numeric: true }),
		);
		const total = [...byFingerprint.values()].reduce((sum, n) => sum + n, 0);
		if (job) await noteFinished(job);
		const published = await readPublished(imagesDir);
		const out: AdminImage = {
			default: aliases.default,
			previous: aliases.previous,
			images: views,
			otherWorkspaces: total - counted,
			job,
			newerPublished: newerPublishedImage(
				published?.image ?? null,
				images.map((image) => image.version),
			),
			disk: await diskOf(imagesDir),
		};
		return reply.header("cache-control", "no-store").send(out);
	});

	app.get("/admin/image/diff", adminOnly, async (request, reply) => {
		if (off(reply) || !imagesDir) return;
		const query = ImageDiffQuery.safeParse(request.query);
		if (!query.success) {
			return sendError(
				reply,
				400,
				"VALIDATION_FAILED",
				"from and to must be image versions",
			);
		}
		const from = await readJson(
			join(imagesDir, query.data.from, "manifest.json"),
			ImageManifest,
		);
		const to = await readJson(
			join(imagesDir, query.data.to, "manifest.json"),
			ImageManifest,
		);
		if (!from || !to) {
			return sendError(reply, 404, "NOT_FOUND", "No manifest for that image.");
		}
		return diffManifests(from, to);
	});

	// jscpd:ignore-start -- certificate and image jobs have their own readers and types.
	app.get("/admin/image/jobs/:id", adminOnly, async (request, reply) => {
		if (off(reply) || !jobsDir) return;
		const id = ImageJobId.safeParse((request.params as { id: string }).id);
		if (!id.success)
			return sendError(reply, 400, "VALIDATION_FAILED", "invalid job id");
		const job =
			(await readJob(jobsDir, id.data)) ??
			(await queuedJobs(jobsDir)).find((j) => j.id === id.data) ??
			null;
		if (!job) return sendError(reply, 404, "NOT_FOUND", "No such job.");
		await noteFinished(job);
		const log = await tailLines(join(jobsDir, id.data, "log.txt"), IMAGE_LOG_LINES);
		return reply.header("cache-control", "no-store").send({ job, log });
	});
	// jscpd:ignore-end

	/** Why the store refuses this job before it is queued, or null. */
	async function refuseImageJob(
		wanted: ImageJobRequest,
		imagesDir: string,
	): Promise<{ status: 404 | 409; code: ApiError["code"]; message: string } | null> {
		const { aliases } = await readStore(imagesDir);
		if (wanted.kind === "activate") {
			const health = await readJson(
				join(imagesDir, wanted.version, "health.json"),
				ImageHealth,
			);
			if (wanted.version === aliases.default) {
				return {
					status: 409,
					code: "IMAGE_ALREADY_DEFAULT",
					message: "That image is already the default.",
				};
			}
			if (health?.result !== "passed") {
				return {
					status: 409,
					code: "IMAGE_NOT_HEALTHY",
					message: "Only an image that passed its health check can become the default.",
				};
			}
		}
		if (wanted.kind === "delete") {
			// The job refuses these too; the API says why before anything is queued.
			if (wanted.version === aliases.default || wanted.version === aliases.previous) {
				return {
					status: 409,
					code: "IMAGE_IN_USE",
					message: "The default and the previous image cannot be deleted.",
				};
			}
			if (!(await listDir(imagesDir)).includes(wanted.version)) {
				return {
					status: 404,
					code: "NOT_FOUND",
					message: "No such image on this host.",
				};
			}
		}
		if (wanted.kind === "rollback" && (!aliases.previous || !aliases.default)) {
			return {
				status: 409,
				code: "IMAGE_NO_PREVIOUS",
				message: "There is no previous image to roll back to.",
			};
		}
		return null;
	}

	app.post("/admin/image/jobs", adminOnly, async (request, reply) => {
		if (off(reply) || !jobsDir || !imagesDir) return;
		const admin = requireUser(request);
		const body = ImageJobRequest.safeParse(request.body ?? {});
		if (!body.success) {
			return sendError(
				reply,
				400,
				"VALIDATION_FAILED",
				"unknown kind, choice or version",
			);
		}
		const wanted = body.data;
		if (writing) {
			return sendError(
				reply,
				409,
				"IMAGE_JOB_BUSY",
				"An image job is already waiting or running.",
			);
		}
		writing = true;
		try {
			const jobs = await allJobs(jobsDir);
			if (jobs.some((j) => isJobActive(j, IMAGE_JOB_STALE_MS))) {
				return sendError(
					reply,
					409,
					"IMAGE_JOB_BUSY",
					"An image job is already waiting or running.",
				);
			}
			const refused = await refuseImageJob(wanted, imagesDir);
			if (refused) {
				return sendError(reply, refused.status, refused.code, refused.message);
			}

			const id = randomUUID();
			const file: ImageJobRequestFile = {
				id,
				requestedAt: new Date().toISOString(),
				requestedBy: admin.id,
				request: wanted,
			};
			await writeRequestFile(jobsDir, file, 0o640);
			await recordAudit(db, {
				actor: `user:${admin.id}`,
				target: id,
				action: "image.job_requested",
				result: "ok",
				metadata: wanted,
			});
			return reply.status(202).send(queuedView(file));
		} finally {
			writing = false;
		}
	});
}
