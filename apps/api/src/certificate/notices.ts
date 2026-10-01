import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
	CERTIFICATE_EXPIRY_WARNING_DAYS,
	type CertificateInfo,
	CertificateStatusFile,
} from "@portikus/contracts";
import type { Database } from "@portikus/db";
import { errorMessage, type Logger } from "@portikus/observability";
import type { Kysely } from "kysely";
import { notifyOnce } from "../image/release-notices.js";
import { allJobs, noteFinished } from "./jobs.js";

/** The status directory sits beside the job directory: /var/lib/portikus/certificate. */
export function certificateStatusDirOf(jobsDir: string): string {
	return join(dirname(jobsDir), "certificate");
}

/** `status.json` from the hourly check; null when missing or malformed. */
export async function readCertificateStatus(
	statusDir: string,
): Promise<CertificateStatusFile | null> {
	try {
		const parsed = CertificateStatusFile.safeParse(
			JSON.parse(await readFile(join(statusDir, "status.json"), "utf8")),
		);
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}

/** One certificate is its name and expiry: a renewal makes a new one. */
function certificateKey(info: CertificateInfo): string {
	return `${info.name}@${info.notAfter}`;
}

/**
 * Tell every enabled administrator once per certificate per condition
 * (SPEC.md 22.4): expiry within 14 days, and a failed renewal.
 */
export async function noticeCertificates(
	db: Kysely<Database>,
	statusDir: string,
	now: Date = new Date(),
): Promise<void> {
	const status = await readCertificateStatus(statusDir);
	// Caddy's internal authority issues leaves that last about 12 hours and
	// renews them itself, so an expiry notice would fire twice a day.
	if (!status || status.source === "internal") return;
	const limit = now.getTime() + CERTIFICATE_EXPIRY_WARNING_DAYS * 86_400_000;
	for (const info of [status.site, status.preview]) {
		if (!info || new Date(info.notAfter).getTime() > limit) continue;
		const day = info.notAfter.slice(0, 10);
		await notifyOnce(db, {
			action: "certificate.expiry_noticed",
			target: certificateKey(info),
			actor: "certificate-check",
			tone: "warning",
			title: `The certificate for ${info.name} expires on ${day}`,
			body: "Open Admin, then Certificate, to renew it or change how it is issued.",
		});
	}
	const renewal = status.lastRenewal;
	if (renewal && !renewal.ok && status.site) {
		const name = renewal.name ?? status.site.name;
		const info = status.preview?.name === name ? status.preview : status.site;
		await notifyOnce(db, {
			action: "certificate.renewal_failure_noticed",
			target: `${name}@${info.notAfter}`,
			actor: "certificate-check",
			tone: "danger",
			title: "A certificate did not renew",
			body: `The certificate for ${name} did not renew. Open Admin, then Certificate, to see the error and try again.`,
		});
	}
}

/** Check now and every interval; errors are logged, never thrown. */
export function startCertificateNotices(options: {
	db: Kysely<Database>;
	logger: Logger;
	jobsDir: string;
	intervalSeconds: number;
}): () => void {
	const { db, logger, jobsDir, intervalSeconds } = options;
	const statusDir = certificateStatusDirOf(jobsDir);
	const tick = async (): Promise<void> => {
		try {
			// Audit jobs that finished while no one had the page open, before the job prunes them.
			await noteFinished(db, await allJobs(jobsDir));
			await noticeCertificates(db, statusDir);
		} catch (e) {
			logger.error({ error: errorMessage(e) }, "certificate notice error");
		}
	};
	const timer = setInterval(() => void tick(), intervalSeconds * 1000);
	timer.unref();
	void tick();
	return () => clearInterval(timer);
}
