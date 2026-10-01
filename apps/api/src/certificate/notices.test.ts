/**
 * Certificate notices (SPEC.md 22.4): every enabled administrator hears
 * once per certificate per condition, for expiry within 14 days and for a
 * failed renewal.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CertificateInfo, CertificateStatusFile } from "@portikus/contracts";
import {
	createTestDb,
	hasTestDb,
	insertTestUser,
	type TestDb,
} from "@portikus/db/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import {
	certificateStatusDirOf,
	noticeCertificates,
	startCertificateNotices,
} from "./notices.js";

const skip = !hasTestDb();
const NOW = new Date("2026-09-30T12:00:00.000Z");

let testDb: TestDb;
let dir: string;

function info(notAfter: string, name = "portikus.example.edu"): CertificateInfo {
	return {
		name,
		issuer: "R11",
		names: [name],
		notBefore: "2026-07-01T00:00:00.000Z",
		notAfter,
	};
}

async function putStatus(over: Partial<CertificateStatusFile>) {
	const status: CertificateStatusFile = {
		checkedAt: NOW.toISOString(),
		source: "acme",
		settings: {
			source: "acme",
			directory: "https://acme-v02.api.letsencrypt.org/directory",
			email: "admin@example.edu",
			eab: null,
			challenge: { mode: "http01" },
		},
		previousAvailable: false,
		site: null,
		preview: null,
		lastRenewal: null,
		...over,
	};
	await writeFile(join(dir, "status.json"), JSON.stringify(status));
}

async function notifications() {
	return testDb.db.selectFrom("notifications").selectAll().execute();
}

beforeAll(async () => {
	if (skip) return;
	testDb = await createTestDb();
});

afterAll(async () => {
	if (skip) return;
	await testDb.close();
});

beforeEach(async () => {
	if (skip) return;
	await testDb.truncate();
	dir = await mkdtemp(join(tmpdir(), "portikus-cert-status-"));
	await insertTestUser(testDb.db, { role: "administrator", email: "a1@example.edu" });
	await insertTestUser(testDb.db, { role: "administrator", email: "a2@example.edu" });
	await insertTestUser(testDb.db, { role: "student", email: "s@example.edu" });
	return () => rm(dir, { recursive: true, force: true });
});

test("the status directory sits beside the job directory", () => {
	expect(certificateStatusDirOf("/var/lib/portikus/certificate-jobs")).toBe(
		"/var/lib/portikus/certificate",
	);
});

describe.skipIf(skip)("noticeCertificates", () => {
	test("warns each administrator once when a certificate expires within 14 days", async () => {
		await putStatus({ site: info("2026-10-10T00:00:00.000Z") });
		await noticeCertificates(testDb.db, dir, NOW);
		await noticeCertificates(testDb.db, dir, NOW);
		const rows = await notifications();
		expect(rows).toHaveLength(2);
		expect(rows[0]?.tone).toBe("warning");
		expect(rows[0]?.title).toContain("2026-10-10");
	});

	test("says nothing for a certificate with more than 14 days left", async () => {
		await putStatus({ site: info("2026-11-30T00:00:00.000Z") });
		await noticeCertificates(testDb.db, dir, NOW);
		expect(await notifications()).toHaveLength(0);
	});

	test("a renewed certificate that nears expiry again is a new notice", async () => {
		await putStatus({ site: info("2026-10-10T00:00:00.000Z") });
		await noticeCertificates(testDb.db, dir, NOW);
		await putStatus({ site: info("2026-10-12T00:00:00.000Z") });
		await noticeCertificates(testDb.db, dir, NOW);
		expect(await notifications()).toHaveLength(4);
	});

	test("reports a failed renewal once per certificate", async () => {
		const failed = { ok: false, at: NOW.toISOString(), message: "rate limited" };
		await putStatus({ site: info("2026-12-01T00:00:00.000Z"), lastRenewal: failed });
		await noticeCertificates(testDb.db, dir, NOW);
		await putStatus({
			site: info("2026-12-01T00:00:00.000Z"),
			lastRenewal: { ...failed, at: "2026-09-30T13:00:00.000Z" },
		});
		await noticeCertificates(testDb.db, dir, NOW);
		const rows = await notifications();
		expect(rows).toHaveLength(2);
		expect(rows[0]?.tone).toBe("danger");
		expect(rows[0]?.title).toBe("A certificate did not renew");
	});

	test("a failed renewal names the certificate the journal named", async () => {
		const preview = info("2026-12-02T00:00:00.000Z", "x-3000.preview.example.edu");
		await putStatus({
			site: info("2026-12-01T00:00:00.000Z"),
			preview,
			lastRenewal: {
				ok: false,
				at: NOW.toISOString(),
				name: preview.name,
				message: "rate limited",
			},
		});
		await noticeCertificates(testDb.db, dir, NOW);
		const rows = await notifications();
		expect(rows[0]?.title).toBe("A certificate did not renew");
		expect(rows[0]?.body).toContain("x-3000.preview.example.edu");
	});

	test("Caddy's internal authority never gets an expiry notice", async () => {
		// Its leaves last about 12 hours and renew themselves.
		await putStatus({
			source: "internal",
			settings: { source: "internal" },
			site: info("2026-09-30T23:00:00.000Z"),
		});
		await noticeCertificates(testDb.db, dir, NOW);
		expect(await notifications()).toHaveLength(0);
	});

	test("a missing or malformed status file is ignored", async () => {
		await noticeCertificates(testDb.db, dir, NOW);
		await writeFile(join(dir, "status.json"), "{");
		await noticeCertificates(testDb.db, dir, NOW);
		expect(await notifications()).toHaveLength(0);
	});
});

describe.skipIf(skip)("startCertificateNotices", () => {
	test("audits a job that finished while nobody had the page open", async () => {
		const jobsDir = join(dir, "certificate-jobs");
		const id = "11111111-2222-4333-8444-555555555555";
		await mkdir(join(jobsDir, id), { recursive: true });
		await writeFile(
			join(jobsDir, id, "status.json"),
			JSON.stringify({
				id,
				kind: "renew",
				state: "succeeded",
				step: "Done",
				message: null,
				restored: false,
				startedAt: NOW.toISOString(),
				finishedAt: NOW.toISOString(),
			}),
		);
		const logger = { error: vi.fn() };
		const stop = startCertificateNotices({
			db: testDb.db,
			logger: logger as never,
			jobsDir,
			intervalSeconds: 3600,
		});
		await vi.waitFor(async () => {
			const rows = await testDb.db
				.selectFrom("audit_events")
				.select("target")
				.where("action", "=", "certificate.job_finished")
				.execute();
			expect(rows.map((r) => r.target)).toEqual([id]);
		});
		stop();
		expect(logger.error).not.toHaveBeenCalled();
	});
});
