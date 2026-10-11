import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
	isJobActive,
	SITE_JOB_FINISHED_STATES,
	SITE_JOB_STALE_MS,
	type SiteJobBody,
	type SiteJobCode,
	SiteJobId,
	type SiteJobRequest,
	SiteJobStatusFile,
	type SiteJobView,
} from "@portikus/contracts";
import { type Database, recordAudit } from "@portikus/db";
import type { Kysely } from "kysely";
import { recordAuditOnce } from "../audit-once.js";
import {
	fileTime,
	listDir,
	readJson,
	sweepTempRequests,
	tailLines,
	writeRequestFile,
} from "../job-files.js";

/**
 * The API side of the root site job (ADR 0059): the API writes
 * `request-<id>.json` into SITE_JOBS_DIR and reads `status/<id>.json` and
 * `status/<id>.log` back. A signin request may hold the client secret, so a
 * request file's body is never read back.
 */

const REQUEST_FILE = /^request-([0-9a-f-]{36})\.json$/;
const STATUS_FILE = /^([0-9a-f-]{36})\.json$/;

/** Owner-only: a signin request may hold the client secret. */
const REQUEST_MODE = 0o600;

export function queuedView(id: string, requestedAt: string | null): SiteJobView {
	return {
		id,
		kind: null,
		state: "queued",
		code: null,
		requestedAt,
		startedAt: null,
		finishedAt: null,
		trialEndsAt: null,
	};
}

function statusDir(dir: string): string {
	return join(dir, "status");
}

export async function readSiteJob(
	dir: string,
	id: string,
): Promise<SiteJobView | null> {
	if (!SiteJobId.safeParse(id).success) return null;
	const status = await readJson(join(statusDir(dir), `${id}.json`), SiteJobStatusFile);
	if (status && status.id === id) {
		return {
			id,
			kind: status.kind,
			state: status.state,
			code: status.code,
			requestedAt: null,
			startedAt: status.startedAt,
			finishedAt: status.finishedAt,
			trialEndsAt: status.trialEndsAt ?? null,
		};
	}
	const requestedAt = await fileTime(join(dir, `request-${id}.json`));
	return requestedAt ? queuedView(id, requestedAt) : null;
}

/** Every job the directory holds: requests still waiting, then those the job took. */
export async function allSiteJobs(dir: string): Promise<SiteJobView[]> {
	const jobs: SiteJobView[] = [];
	for (const name of await listDir(dir)) {
		const id = REQUEST_FILE.exec(name)?.[1];
		if (!id || !SiteJobId.safeParse(id).success) continue;
		jobs.push(queuedView(id, await fileTime(join(dir, name))));
	}
	for (const name of await listDir(statusDir(dir))) {
		const id = STATUS_FILE.exec(name)?.[1];
		if (!id || jobs.some((job) => job.id === id)) continue;
		const job = await readSiteJob(dir, id);
		if (job) jobs.push(job);
	}
	return jobs;
}

/** The last `count` lines of a job's setup output. */
export function siteJobLog(dir: string, id: string, count: number): Promise<string[]> {
	if (!SiteJobId.safeParse(id).success) return Promise.resolve([]);
	return tailLines(join(statusDir(dir), `${id}.log`), count);
}

/**
 * Why a new request of `kind` must wait, or null. An address or signin
 * change waits for an open trial to end, and any request waits for a job
 * that is queued or running (ADR 0059).
 */
export function siteJobBlock(
	kind: SiteJobBody["kind"],
	jobs: SiteJobView[],
	now: number = Date.now(),
): Extract<SiteJobCode, "busy" | "trial_open"> | null {
	if (jobs.some((job) => isJobActive(job, SITE_JOB_STALE_MS, now))) return "busy";
	if (
		(kind === "address" || kind === "signin") &&
		jobs.some((j) => j.state === "trial")
	) {
		return "trial_open";
	}
	return null;
}

/** What an audit row may say about a request: never a secret (SPEC.md 24.8, 24.11). */
export function requestSummary(body: SiteJobBody): Record<string, unknown> {
	switch (body.kind) {
		case "proxy-hosts":
			return { kind: body.kind, hosts: body.hosts };
		case "lti-platforms":
			return {
				kind: body.kind,
				platforms: body.platforms.map((p) => ({
					name: p.name,
					issuer: p.issuer,
					clientId: p.clientId,
				})),
			};
		case "address":
			return { kind: body.kind, host: body.host, port: body.port };
		case "signin":
			return {
				kind: body.kind,
				provider: body.provider,
				entraTenantId: body.entraTenantId ?? null,
				googleDomains: body.googleDomains ?? null,
				oidcIssuer: body.oidcIssuer ?? null,
				clientId: body.clientId ?? null,
				clientSecretChanged: body.clientSecret !== null,
			};
		case "keep":
		case "rollback":
			return { kind: body.kind, trialId: body.trialId };
	}
}

/**
 * Write a request file for the root job and its `site.job_requested` audit
 * row. The caller checks {@link siteJobBlock} first under its own write lock.
 */
export async function requestSiteJob(
	db: Kysely<Database>,
	dir: string,
	actor: string,
	body: SiteJobBody,
): Promise<SiteJobView> {
	const id = randomUUID();
	const requestedAt = new Date().toISOString();
	const file = { ...body, version: 1, id, requestedAt } as SiteJobRequest;
	await sweepTempRequests(dir);
	await writeRequestFile(dir, file, REQUEST_MODE);
	await recordAudit(db, {
		actor,
		target: id,
		action: "site.job_requested",
		result: "ok",
		metadata: requestSummary(body),
	});
	return queuedView(id, requestedAt);
}

/** Write `site.job_finished` the first time the API sees each job end (SPEC.md 24.11). */
export async function noteSiteJobsFinished(
	db: Kysely<Database>,
	jobs: SiteJobView[],
): Promise<void> {
	await recordAuditOnce(
		db,
		"site.job_finished",
		jobs
			.filter((job) => SITE_JOB_FINISHED_STATES.includes(job.state))
			.map((job) => ({
				actor: "site-job",
				target: job.id,
				result: job.state === "failed" ? "failed" : "ok",
				metadata: { kind: job.kind, state: job.state, code: job.code },
			})),
	);
}
