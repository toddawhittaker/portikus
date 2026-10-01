import { randomUUID } from "node:crypto";
import { readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { requireRole, requireUser } from "@portikus/auth";
import {
	type AdminCertificate,
	CERTIFICATE_LOG_LINES,
	CertificateJobId,
	CertificateJobRecord,
	CertificateJobRequest,
	type CertificateJobRequestFile,
	CertificateJobStatusFile,
	type CertificateJobView,
	CertificatePreflightRequest,
	type CertificateSettings,
	type CertificateSettingsView,
	DNS_PROVIDER_FIELDS,
} from "@portikus/contracts";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { ZodType } from "zod";
import {
	certificateStatusDirOf,
	readCertificateStatus,
} from "../certificate/notices.js";
import {
	type NonceStore,
	type PreflightNet,
	runPreflight,
	systemNet,
} from "../certificate/preflight.js";
import { checkUpload } from "../certificate/upload-check.js";
import type { ServerDeps } from "../server.js";
import { tailLines } from "./admin-image.js";
import { sendError } from "./project-scope.js";

const adminOnly = { preHandler: requireRole("administrator") };
const REQUEST_FILE = /^request-([0-9a-f-]{36})\.json$/;

async function readJson<T>(path: string, schema: ZodType<T>): Promise<T | null> {
	try {
		const parsed = schema.safeParse(JSON.parse(await readFile(path, "utf8")));
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

/** The request file's body is never read back: it may hold secrets. Only its name and age are used. */
function queuedView(
	id: string,
	requestedAt: string | null,
	kind: CertificateJobView["kind"],
) {
	const view: CertificateJobView = {
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
	return view;
}

function isFinished(job: CertificateJobView): boolean {
	return job.state === "succeeded" || job.state === "failed" || job.state === "refused";
}

/** What an audit row may say about settings: never a secret (SPEC.md 24.8). */
function auditSummary(settings: CertificateSettings | CertificateSettingsView | null) {
	if (!settings) return { source: null, directory: null, provider: null };
	if (settings.source !== "acme") {
		return { source: settings.source, directory: null, provider: null };
	}
	const challenge = settings.challenge;
	const provider =
		challenge.mode === "http01"
			? "http01"
			: "dns" in challenge
				? challenge.dns.provider
				: challenge.provider;
	return { source: "acme", directory: settings.directory, provider };
}

/** An empty secret field means "keep the stored one", the same as leaving it out. */
function dropBlankSecrets(body: unknown): unknown {
	if (!body || typeof body !== "object") return body;
	const copy = structuredClone(body) as {
		settings?: {
			eab?: Record<string, unknown>;
			challenge?: { dns?: { provider?: unknown; fields?: Record<string, unknown> } };
			site?: Record<string, unknown>;
			preview?: Record<string, unknown>;
		};
	};
	const settings = copy.settings;
	if (!settings || typeof settings !== "object") return copy;
	const blank = (holder: Record<string, unknown> | undefined, name: string) => {
		if (holder && typeof holder === "object" && holder[name] === "")
			delete holder[name];
	};
	blank(settings.eab, "hmacKey");
	blank(settings.site, "privateKey");
	blank(settings.preview, "privateKey");
	const dns = settings.challenge?.dns;
	if (dns && typeof dns.provider === "string" && dns.provider in DNS_PROVIDER_FIELDS) {
		const fields =
			DNS_PROVIDER_FIELDS[dns.provider as keyof typeof DNS_PROVIDER_FIELDS];
		for (const name of fields.secret) blank(dns.fields, name);
	}
	return copy;
}

/** The first secret left blank that has no stored value to keep, or null. */
function missingSecret(
	settings: CertificateSettings,
	current: CertificateSettingsView | null,
): string | null {
	if (settings.source === "acme") {
		const stored = current?.source === "acme" ? current : null;
		if (
			settings.eab &&
			settings.eab.hmacKey === undefined &&
			!stored?.eab?.hmacKeySet
		) {
			return "the EAB HMAC key";
		}
		if (settings.challenge.mode === "dns01") {
			const { provider, fields } = settings.challenge.dns;
			const storedDns =
				stored?.challenge.mode === "dns01" && stored.challenge.provider === provider
					? stored.challenge.secretsSet
					: {};
			const values = fields as Record<string, string | undefined>;
			for (const name of DNS_PROVIDER_FIELDS[provider].secret) {
				if (values[name] === undefined && storedDns[name] !== true) return name;
			}
		}
	}
	if (settings.source === "files") {
		const stored = current?.source === "files" ? current : null;
		if (settings.site.privateKey === undefined && !stored?.site.privateKeySet) {
			return "the site private key";
		}
		if (
			settings.preview &&
			settings.preview.privateKey === undefined &&
			!stored?.preview?.privateKeySet
		) {
			return "the preview private key";
		}
	}
	return null;
}

/**
 * The Certificate section (docs/SPEC.md sections 20.1, 22.4 and 24.8).
 * The API reads what the root job writes and writes nothing but one request
 * file into CERTIFICATE_JOBS_DIR. Secrets travel only in that file and
 * never come back out. With CERTIFICATE_JOBS_DIR unset every route is 404.
 */
export function registerAdminCertificateRoutes(
	app: FastifyInstance,
	{ db, config }: ServerDeps,
	nonces: NonceStore,
	net: PreflightNet = systemNet,
): void {
	const jobsDir = config.CERTIFICATE_JOBS_DIR;
	const statusDir = jobsDir ? certificateStatusDirOf(jobsDir) : null;
	const siteName = new URL(config.PUBLIC_URL).hostname;
	// One API process: this closes the gap between checking and writing.
	let writing = false;

	function off(reply: FastifyReply): boolean {
		if (jobsDir) return false;
		sendError(reply, 404, "NOT_FOUND", "Not found.");
		return true;
	}

	async function queuedJobs(dir: string): Promise<CertificateJobView[]> {
		const jobs: CertificateJobView[] = [];
		for (const name of await listDir(dir)) {
			const match = REQUEST_FILE.exec(name);
			if (!match?.[1] || !CertificateJobId.safeParse(match[1]).success) continue;
			jobs.push(queuedView(match[1], null, null));
		}
		return jobs;
	}

	async function readJob(dir: string, id: string): Promise<CertificateJobView | null> {
		const status = await readJson(
			join(dir, id, "status.json"),
			CertificateJobStatusFile,
		);
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

	async function allJobs(dir: string): Promise<CertificateJobView[]> {
		const jobs = await queuedJobs(dir);
		for (const name of await listDir(dir)) {
			if (!CertificateJobId.safeParse(name).success) continue;
			const job = await readJob(dir, name);
			if (job) jobs.push(job);
		}
		return jobs;
	}

	/** Write certificate.job_finished the first time the API sees each job finished, `reset` included. */
	async function noteFinished(jobs: CertificateJobView[]): Promise<void> {
		const finished = jobs.filter(isFinished);
		if (finished.length === 0) return;
		const seen = await db
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
			await db
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
	}

	function currentOf(jobs: CertificateJobView[]): CertificateJobView | null {
		const active =
			jobs.find((j) => j.state === "running") ?? jobs.find((j) => j.state === "queued");
		if (active) return active;
		const byStart = [...jobs].sort((a, b) =>
			(b.startedAt ?? "").localeCompare(a.startedAt ?? ""),
		);
		return byStart[0] ?? null;
	}

	async function rootAvailable(dir: string): Promise<boolean> {
		return (await listDir(dir)).includes("root.crt");
	}

	app.get("/admin/certificate", adminOnly, async (_request, reply) => {
		if (off(reply) || !jobsDir || !statusDir) return;
		const jobs = await allJobs(jobsDir);
		await noteFinished(jobs);
		const status = await readCertificateStatus(statusDir);
		const out: AdminCertificate = {
			siteName,
			previewSuffix: config.PREVIEW_SUFFIX,
			settings: status?.settings ?? null,
			previousAvailable: status?.previousAvailable ?? false,
			status,
			job: currentOf(jobs),
			rootCertificateAvailable: await rootAvailable(statusDir),
		};
		return reply.header("cache-control", "no-store").send(out);
	});

	app.get("/admin/certificate/jobs/:id", adminOnly, async (request, reply) => {
		if (off(reply) || !jobsDir) return;
		const id = CertificateJobId.safeParse((request.params as { id: string }).id);
		if (!id.success)
			return sendError(reply, 400, "VALIDATION_FAILED", "invalid job id");
		const job =
			(await readJob(jobsDir, id.data)) ??
			(await queuedJobs(jobsDir)).find((j) => j.id === id.data) ??
			null;
		if (!job) return sendError(reply, 404, "NOT_FOUND", "No such job.");
		await noteFinished([job]);
		const log = await tailLines(
			join(jobsDir, id.data, "log.txt"),
			CERTIFICATE_LOG_LINES,
		);
		return reply.header("cache-control", "no-store").send({ job, log });
	});

	app.get("/admin/certificate/root.crt", adminOnly, async (_request, reply) => {
		if (off(reply) || !statusDir) return;
		let pem: string;
		try {
			pem = await readFile(join(statusDir, "root.crt"), "utf8");
		} catch {
			return sendError(reply, 404, "NOT_FOUND", "No internal root certificate yet.");
		}
		return reply
			.header("content-type", "application/x-x509-ca-cert")
			.header("content-disposition", 'attachment; filename="portikus-root.crt"')
			.header("cache-control", "no-store")
			.send(pem);
	});

	app.post("/admin/certificate/preflight", adminOnly, async (request, reply) => {
		if (off(reply)) return;
		const body = CertificatePreflightRequest.safeParse(request.body ?? {});
		if (!body.success) {
			return sendError(reply, 400, "VALIDATION_FAILED", "mode must be dns01 or http01");
		}
		const result = await runPreflight({ config, net, nonces, mode: body.data.mode });
		return reply.header("cache-control", "no-store").send(result);
	});

	app.post("/admin/certificate/jobs", adminOnly, async (request, reply) => {
		if (off(reply) || !jobsDir || !statusDir) return;
		const admin = requireUser(request);
		const body = CertificateJobRequest.safeParse(dropBlankSecrets(request.body ?? {}));
		if (!body.success) {
			// Zod's issues can quote the input; only the field paths are named.
			const fields = [...new Set(body.error.issues.map((i) => i.path.join(".")))];
			return sendError(
				reply,
				400,
				"VALIDATION_FAILED",
				`Check these fields: ${fields.join(", ") || "kind"}.`,
			);
		}
		const wanted = body.data;
		if (writing) {
			return sendError(
				reply,
				409,
				"CERTIFICATE_JOB_BUSY",
				"A certificate job is already waiting or running.",
			);
		}
		writing = true;
		try {
			const jobs = await allJobs(jobsDir);
			if (jobs.some((j) => j.state === "queued" || j.state === "running")) {
				return sendError(
					reply,
					409,
					"CERTIFICATE_JOB_BUSY",
					"A certificate job is already waiting or running.",
				);
			}
			const status = await readCertificateStatus(statusDir);
			if (wanted.kind === "rollback" && !status?.previousAvailable) {
				return sendError(
					reply,
					409,
					"CERTIFICATE_NO_PREVIOUS",
					"There are no earlier certificate settings to roll back to.",
				);
			}
			if (wanted.kind === "test" || wanted.kind === "apply") {
				const settings = wanted.settings;
				const missing = missingSecret(settings, status?.settings ?? null);
				if (missing) {
					return sendError(
						reply,
						400,
						"CERTIFICATE_SECRET_REQUIRED",
						`Enter ${missing}; no stored value can be kept.`,
					);
				}
				if (settings.source === "files") {
					const wildcard = `*.${config.PREVIEW_SUFFIX}`;
					const uploads = settings.preview
						? [
								{ label: "Site certificate", upload: settings.site, names: [siteName] },
								{
									label: "Preview certificate",
									upload: settings.preview,
									names: [wildcard],
								},
							]
						: [
								{
									label: "Site certificate",
									upload: settings.site,
									names: [siteName, wildcard],
								},
							];
					for (const { label, upload, names } of uploads) {
						const refusal = checkUpload(upload, names);
						if (refusal) {
							return sendError(
								reply,
								400,
								"CERTIFICATE_UPLOAD_REFUSED",
								`${label}: the ${refusal.check} check failed. ${refusal.message}`,
							);
						}
					}
				}
				if (settings.source === "acme") {
					const preflight = await runPreflight({
						config,
						net,
						nonces,
						mode: settings.challenge.mode,
					});
					const failed = preflight.checks.filter((c) => c.result === "failed");
					if (failed.length > 0) {
						return sendError(
							reply,
							409,
							"CERTIFICATE_PREFLIGHT_FAILED",
							`Pre-flight failed. ${failed.map((c) => c.message).join(" ")}`,
						);
					}
				}
			}

			const id = randomUUID();
			const requestedAt = new Date().toISOString();
			const file: CertificateJobRequestFile = {
				id,
				requestedAt,
				requestedBy: admin.id,
				request: wanted,
			};
			// Owner-only, because it may hold secrets; written aside, then renamed,
			// so the path unit never reads half a file.
			const temp = join(jobsDir, `.request-${id}.tmp`);
			await writeFile(temp, `${JSON.stringify(file)}\n`, { flag: "wx", mode: 0o600 });
			await rename(temp, join(jobsDir, `request-${id}.json`));
			await db
				.insertInto("audit_events")
				.values({
					actor: `user:${admin.id}`,
					target: id,
					action: "certificate.job_requested",
					result: "ok",
					metadata: JSON.stringify({
						kind: wanted.kind,
						...auditSummary("settings" in wanted ? wanted.settings : null),
					}),
				})
				.execute();
			return reply.status(202).send(queuedView(id, requestedAt, wanted.kind));
		} finally {
			writing = false;
		}
	});
}
