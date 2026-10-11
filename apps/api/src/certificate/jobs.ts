import { join } from "node:path";
import {
	CertificateJobId,
	CertificateJobRecord,
	CertificateJobStatusFile,
	type CertificateJobView,
	type CertificateSettings,
	type CertificateSettingsView,
} from "@portikus/contracts";
import type { Database } from "@portikus/db";
import type { Kysely } from "kysely";
import { recordAuditOnce } from "../audit-once.js";
import { fileTime, listDir, readJson } from "../job-files.js";

const REQUEST_FILE = /^request-([0-9a-f-]{36})\.json$/;

/** The request file's body is never read back: it may hold secrets. Only its name and age are used. */
export function queuedView(
	id: string,
	requestedAt: string | null,
	kind: CertificateJobView["kind"],
): CertificateJobView {
	return {
		id,
		kind,
		state: "queued",
		step: "Waiting to start",
		message: null,
		restored: false,
		requestedAt,
		startedAt: null,
		finishedAt: null,
		request: null,
	};
}

function isFinished(job: CertificateJobView): boolean {
	return job.state === "succeeded" || job.state === "failed" || job.state === "refused";
}

type AnySettings = CertificateSettings | CertificateSettingsView;
type AcmeSettings = Extract<AnySettings, { source: "acme" }>;

/** The DNS provider, or "http01"; the request and the stored view shape it differently. */
function providerOf(challenge: AcmeSettings["challenge"]): string {
	if (challenge.mode === "http01") return "http01";
	return "dns" in challenge ? challenge.dns.provider : challenge.provider;
}

/** What an audit row may say about settings: never a secret (SPEC.md 24.8). */
export function auditSummary(settings: AnySettings | null) {
	if (!settings) return { source: null, directory: null, provider: null };
	if (settings.source !== "acme") {
		return { source: settings.source, directory: null, provider: null };
	}
	return {
		source: "acme",
		directory: settings.directory,
		provider: providerOf(settings.challenge),
	};
}

export async function queuedJobs(dir: string): Promise<CertificateJobView[]> {
	const jobs: CertificateJobView[] = [];
	for (const name of await listDir(dir)) {
		const match = REQUEST_FILE.exec(name);
		if (!match?.[1] || !CertificateJobId.safeParse(match[1]).success) continue;
		jobs.push(queuedView(match[1], await fileTime(join(dir, name)), null));
	}
	return jobs;
}

export async function readJob(
	dir: string,
	id: string,
): Promise<CertificateJobView | null> {
	const status = await readJson(join(dir, id, "status.json"), CertificateJobStatusFile);
	const record = await readJson(join(dir, id, "request.json"), CertificateJobRecord);
	if (!status) {
		if (!record) return null;
		return queuedView(id, await fileTime(join(dir, id, "request.json")), record.kind);
	}
	if (status.id !== id) return null;
	return {
		id,
		kind: status.kind,
		state: status.state,
		step: status.step,
		message: status.message,
		restored: status.restored,
		requestedAt: null,
		startedAt: status.startedAt,
		finishedAt: status.finishedAt,
		request: record,
	};
}

export async function allJobs(dir: string): Promise<CertificateJobView[]> {
	const jobs = await queuedJobs(dir);
	for (const name of await listDir(dir)) {
		if (!CertificateJobId.safeParse(name).success) continue;
		const job = await readJob(dir, name);
		if (job) jobs.push(job);
	}
	return jobs;
}

/**
 * Write certificate.job_finished the first time the API sees each job
 * finished, `reset` included (SPEC.md 24.8). A page load and the hourly
 * tick can race.
 */
export async function noteFinished(
	db: Kysely<Database>,
	jobs: CertificateJobView[],
): Promise<void> {
	await recordAuditOnce(
		db,
		"certificate.job_finished",
		jobs.filter(isFinished).map((job) => ({
			actor: job.kind === "reset" ? "reset-certificate" : "certificate-job",
			target: job.id,
			result: job.state === "succeeded" ? "ok" : "failed",
			metadata: {
				kind: job.kind,
				...auditSummary(job.request?.settings ?? null),
				state: job.state,
			},
		})),
	);
}
