import { randomUUID } from "node:crypto";
import { open, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { requireRole, requireUser } from "@portikus/auth";
import {
	type AdminImage,
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
	ImageVersion,
	type ImageView,
	newerPublishedImage,
} from "@portikus/contracts";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { ZodType } from "zod";
import { diffManifests } from "../image/manifest-diff.js";
import {
	imagesDirOf,
	noticeReleases,
	readPublished,
} from "../image/release-notices.js";
import type { ServerDeps } from "../server.js";
import { sendError } from "./project-scope.js";

const adminOnly = { preHandler: requireRole("administrator") };
const REQUEST_FILE = /^request-([0-9a-f-]{36})\.json$/;
/** log.txt can grow to megabytes during a build; only its tail is read. */
const LOG_TAIL_BYTES = 256 * 1024;

/** Parse a JSON file through `schema`; a missing or malformed file is null. */
async function readJson<T>(path: string, schema: ZodType<T>): Promise<T | null> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch {
		return null;
	}
	try {
		const parsed = schema.safeParse(JSON.parse(text));
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}

async function listDir(path: string): Promise<string[]> {
	try {
		return await readdir(path);
	} catch {
		return [];
	}
}

/** The last `count` lines of a file, reading at most its last LOG_TAIL_BYTES. */
export async function tailLines(path: string, count: number): Promise<string[]> {
	let data: Buffer;
	try {
		const file = await open(path, "r");
		try {
			const { size } = await file.stat();
			const length = Math.min(size, LOG_TAIL_BYTES);
			data = Buffer.alloc(length);
			const { bytesRead } = await file.read(data, 0, length, size - length);
			data = data.subarray(0, bytesRead);
		} finally {
			await file.close();
		}
	} catch {
		return [];
	}
	const lines = data.toString("utf8").split("\n");
	if (lines.at(-1) === "") lines.pop();
	return lines.slice(-count);
}

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
		await db
			.insertInto("audit_events")
			.values({
				actor: "image-job",
				target: job.id,
				action: "image.job_finished",
				result: job.state === "succeeded" ? "ok" : "failed",
				metadata: JSON.stringify({
					kind: job.kind,
					result: job.state,
					version: job.version,
				}),
			})
			.execute();
	}

	/** The queued or running job, else the one started last. */
	function currentOf(jobs: ImageJobView[]): ImageJobView | null {
		const active =
			jobs.find((j) => j.state === "running") ?? jobs.find((j) => j.state === "queued");
		if (active) return active;
		const byStart = [...jobs].sort((a, b) =>
			(b.startedAt ?? "").localeCompare(a.startedAt ?? ""),
		);
		return byStart[0] ?? null;
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
			})),
		);
		return { aliases, images };
	}

	app.get("/admin/image", adminOnly, async (_request, reply) => {
		if (off(reply) || !jobsDir || !imagesDir) return;
		// Jobs first: the root job moves the aliases before it writes "succeeded",
		// so a finished job is never paired with the aliases from before it.
		const job = currentOf(await allJobs(jobsDir));
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
		const views: ImageView[] = images.map(({ version, manifest, health }) => {
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
		// The hourly timer notifies too; a page load just gets there sooner.
		await noticeReleases(db, imagesDir);
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
			if (jobs.some((j) => j.state === "queued" || j.state === "running")) {
				return sendError(
					reply,
					409,
					"IMAGE_JOB_BUSY",
					"An image job is already waiting or running.",
				);
			}
			const { aliases } = await readStore(imagesDir);
			if (wanted.kind === "activate") {
				const health = await readJson(
					join(imagesDir, wanted.version, "health.json"),
					ImageHealth,
				);
				if (wanted.version === aliases.default) {
					return sendError(
						reply,
						409,
						"IMAGE_ALREADY_DEFAULT",
						"That image is already the default.",
					);
				}
				if (health?.result !== "passed") {
					return sendError(
						reply,
						409,
						"IMAGE_NOT_HEALTHY",
						"Only an image that passed its health check can become the default.",
					);
				}
			}
			if (wanted.kind === "rollback" && (!aliases.previous || !aliases.default)) {
				return sendError(
					reply,
					409,
					"IMAGE_NO_PREVIOUS",
					"There is no previous image to roll back to.",
				);
			}

			const id = randomUUID();
			const file: ImageJobRequestFile = {
				id,
				requestedAt: new Date().toISOString(),
				requestedBy: admin.id,
				request: wanted,
			};
			// Write aside, then rename, so the path unit never reads half a file.
			const temp = join(jobsDir, `.request-${id}.tmp`);
			await writeFile(temp, `${JSON.stringify(file)}\n`, { flag: "wx", mode: 0o640 });
			await rename(temp, join(jobsDir, `request-${id}.json`));
			await db
				.insertInto("audit_events")
				.values({
					actor: `user:${admin.id}`,
					target: id,
					action: "image.job_requested",
					result: "ok",
					metadata: JSON.stringify(wanted),
				})
				.execute();
			return reply.status(202).send(queuedView(file));
		} finally {
			writing = false;
		}
	});
}
