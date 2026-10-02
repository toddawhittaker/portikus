import { randomUUID } from "node:crypto";
import { readdir, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { requireRole, requireUser } from "@portikus/auth";
import {
	type AdminCertificate,
	type ApiError,
	CERTIFICATE_LOG_LINES,
	CertificateJobId,
	CertificateJobRequest,
	type CertificateJobRequestFile,
	CertificatePreflightRequest,
	type CertificateSettings,
	type CertificateSettingsView,
	DNS_PROVIDER_FIELDS,
} from "@portikus/contracts";
import { recordAudit } from "@portikus/db";
import type { FastifyInstance, FastifyReply } from "fastify";
import {
	allJobs,
	auditSummary,
	noteFinished,
	queuedJobs,
	queuedView,
	readJob,
} from "../certificate/jobs.js";
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
import type { ServerDeps } from "../deps.js";
import { sendError } from "../http.js";
import { currentJob, listDir, tailLines, writeRequestFile } from "../job-files.js";

const adminOnly = { preHandler: requireRole("administrator") };
const BUSY_MESSAGE = "A certificate job is already waiting or running.";

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
/**
 * The uploads to check and the names each must cover: a separate preview
 * certificate covers the wildcard, otherwise the site certificate covers both.
 */
export function uploadsToCheck(
	settings: Extract<CertificateSettings, { source: "files" }>,
	siteName: string,
	previewSuffix: string,
) {
	const wildcard = `*.${previewSuffix}`;
	if (settings.preview) {
		return [
			{ label: "Site certificate", upload: settings.site, names: [siteName] },
			{ label: "Preview certificate", upload: settings.preview, names: [wildcard] },
		];
	}
	return [
		{ label: "Site certificate", upload: settings.site, names: [siteName, wildcard] },
	];
}

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

	async function rootAvailable(dir: string): Promise<boolean> {
		return (await listDir(dir)).includes("root.crt");
	}

	/** Why new settings cannot be tested or applied, or null when they can. */
	async function refuseSettings(
		settings: CertificateSettings,
		stored: CertificateSettingsView | null,
	): Promise<{ status: 400 | 409; code: ApiError["code"]; message: string } | null> {
		const missing = missingSecret(settings, stored);
		if (missing) {
			return {
				status: 400,
				code: "CERTIFICATE_SECRET_REQUIRED",
				message: `Enter ${missing}; no stored value can be kept.`,
			};
		}
		if (settings.source === "files") {
			for (const { label, upload, names } of uploadsToCheck(
				settings,
				siteName,
				config.PREVIEW_SUFFIX,
			)) {
				const refusal = checkUpload(upload, names);
				if (refusal) {
					return {
						status: 400,
						code: "CERTIFICATE_UPLOAD_REFUSED",
						message: `${label}: the ${refusal.check} check failed. ${refusal.message}`,
					};
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
				return {
					status: 409,
					code: "CERTIFICATE_PREFLIGHT_FAILED",
					message: `Pre-flight failed. ${failed.map((c) => c.message).join(" ")}`,
				};
			}
		}
		return null;
	}

	app.get("/admin/certificate", adminOnly, async (_request, reply) => {
		if (off(reply) || !jobsDir || !statusDir) return;
		const jobs = await allJobs(jobsDir);
		await noteFinished(db, jobs);
		const status = await readCertificateStatus(statusDir);
		const out: AdminCertificate = {
			siteName,
			previewSuffix: config.PREVIEW_SUFFIX,
			settings: status?.settings ?? null,
			previousAvailable: status?.previousAvailable ?? false,
			status,
			job: currentJob(jobs),
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
		await noteFinished(db, [job]);
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
			return sendError(reply, 409, "CERTIFICATE_JOB_BUSY", BUSY_MESSAGE);
		}
		writing = true;
		try {
			const jobs = await allJobs(jobsDir);
			if (jobs.some((j) => j.state === "queued" || j.state === "running")) {
				return sendError(reply, 409, "CERTIFICATE_JOB_BUSY", BUSY_MESSAGE);
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
				const refused = await refuseSettings(wanted.settings, status?.settings ?? null);
				if (refused) {
					return sendError(reply, refused.status, refused.code, refused.message);
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
			// Owner-only, because it may hold secrets.
			await sweepTempRequests(jobsDir);
			await writeRequestFile(jobsDir, file, 0o600);
			await recordAudit(db, {
				actor: `user:${admin.id}`,
				target: id,
				action: "certificate.job_requested",
				result: "ok",
				metadata: {
					kind: wanted.kind,
					...auditSummary("settings" in wanted ? wanted.settings : null),
				},
			});
			return reply.status(202).send(queuedView(id, requestedAt, wanted.kind));
		} finally {
			writing = false;
		}
	});
}

/**
 * Remove temp request files a crash left behind; they may hold secrets.
 * Runs under the write lock, so no write of ours is in flight.
 */
async function sweepTempRequests(jobsDir: string): Promise<void> {
	const names = await readdir(jobsDir).catch(() => [] as string[]);
	for (const name of names) {
		if (name.startsWith(".request-") && name.endsWith(".tmp")) {
			await unlink(join(jobsDir, name)).catch(() => {});
		}
	}
}
