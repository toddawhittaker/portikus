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
import { type Kysely, sql } from "kysely";
import { listDir, readJson } from "../job-files.js";

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
		jobs.push(queuedView(match[1], null, null));
	}
	return jobs;
}

export async function readJob(
	dir: string,
	id: string,
): Promise<CertificateJobView | null> {
	const status = await readJson(join(dir, id, "status.json"), CertificateJobStatusFile);
	const record = await readJson(join(dir, id, "request.json"), CertificateJobRecord);
	if (!status) return record ? queuedView(id, null, record.kind) : null;
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
 * tick can race; the lock makes the check and the insert one step.
 */
export async function noteFinished(
	db: Kysely<Database>,
	jobs: CertificateJobView[],
): Promise<void> {
	const finished = jobs.filter(isFinished);
	if (finished.length === 0) return;
	await db.transaction().execute(async (trx) => {
		await sql`select pg_advisory_xact_lock(hashtext('portikus.certificate-job-finished'))`.execute(
			trx,
		);
		const seen = await trx
			.selectFrom("audit_events")
			.select("target")
			.where("action", "=", "certificate.job_finished")
			.where(
				"target",
				"in",
				finished.map((job) => job.id),
			)
			.execute();
		const seenIds = new Set(seen.map((row) => row.target));
		for (const job of finished) {
			if (seenIds.has(job.id)) continue;
			await trx
				.insertInto("audit_events")
				.values({
					actor: job.kind === "reset" ? "reset-certificate" : "certificate-job",
					target: job.id,
					action: "certificate.job_finished",
					result: job.state === "succeeded" ? "ok" : "failed",
					metadata: JSON.stringify({
						kind: job.kind,
						...auditSummary(job.request?.settings ?? null),
						state: job.state,
					}),
				})
				.execute();
		}
	});
}
