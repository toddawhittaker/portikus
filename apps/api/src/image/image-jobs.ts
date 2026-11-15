import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
	type CodingAgentsFile,
	IMAGE_JOB_SYSTEM_REQUESTER,
	ImageJobId,
	type ImageJobRequest,
	ImageJobRequestFile,
	ImageJobStatusFile,
	type ImageJobView,
	newerCodingAgent,
	type PublishedReleasesFile,
} from "@portikus/contracts";
import { type Database, recordAudit } from "@portikus/db";
import type { Kysely } from "kysely";
import { listDir, readJson, writeRequestFile } from "../job-files.js";

const REQUEST_FILE = /^request-([0-9a-f-]{36})\.json$/;

/**
 * Held while a request file is checked for and written. The route and the
 * nightly agents update share it, and the API is one process.
 */
export const imageJobLock = { held: false };

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

export async function queuedImageJobs(dir: string): Promise<ImageJobView[]> {
	const jobs: ImageJobView[] = [];
	for (const name of await listDir(dir)) {
		if (!REQUEST_FILE.test(name)) continue;
		const file = await readJson(join(dir, name), ImageJobRequestFile);
		if (!file) continue;
		jobs.push(queuedView(file));
	}
	return jobs;
}

export async function readImageJob(
	dir: string,
	id: string,
): Promise<ImageJobView | null> {
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

export async function allImageJobs(dir: string): Promise<ImageJobView[]> {
	const jobs = await queuedImageJobs(dir);
	for (const name of await listDir(dir)) {
		if (!ImageJobId.safeParse(name).success) continue;
		const job = await readImageJob(dir, name);
		if (job) jobs.push(job);
	}
	return jobs;
}

/**
 * Per tool, the version the daily check recorded when it sorts above the one
 * in use (SPEC.md section 22.6). With no coding-agents.json both are null:
 * the page shows setup, not an update.
 */
export function newerCodingAgentsOf(
	published: PublishedReleasesFile | null,
	codingAgents: CodingAgentsFile | null,
): { claude: string | null; codex: string | null } {
	const newest = published?.codingAgents ?? null;
	return {
		claude: codingAgents
			? newerCodingAgent(newest?.claude ?? null, codingAgents.claude.current)
			: null,
		codex: codingAgents
			? newerCodingAgent(newest?.codex ?? null, codingAgents.codex.current)
			: null,
	};
}

/**
 * Write one request file and its `image.job_requested` row. The caller holds
 * `imageJobLock` and has checked that no job waits or runs.
 */
export async function queueImageJob(
	db: Kysely<Database>,
	jobsDir: string,
	request: ImageJobRequest,
	requestedBy: string,
): Promise<ImageJobView> {
	const file: ImageJobRequestFile = {
		id: randomUUID(),
		requestedAt: new Date().toISOString(),
		requestedBy,
		request,
	};
	await writeRequestFile(jobsDir, file, 0o640);
	await recordAudit(db, {
		actor:
			requestedBy === IMAGE_JOB_SYSTEM_REQUESTER
				? IMAGE_JOB_SYSTEM_REQUESTER
				: `user:${requestedBy}`,
		target: file.id,
		action: "image.job_requested",
		result: "ok",
		metadata: request,
	});
	return queuedView(file);
}
