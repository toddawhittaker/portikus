/**
 * certificate.job_finished is written once per job (SPEC.md 24.8), even
 * when a page load and the hourly tick see the same job at once.
 */
import type { CertificateJobView } from "@portikus/contracts";
import { createTestDb, hasTestDb, type TestDb } from "@portikus/db/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { auditSummary, noteFinished, queuedView } from "./jobs.js";

const skip = !hasTestDb();
let testDb: TestDb;

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
});

describe.skipIf(skip)("noteFinished", () => {
	test("concurrent callers write one audit row per finished job", async () => {
		const job: CertificateJobView = {
			...queuedView("11111111-2222-4333-8444-555555555555", null, "renew"),
			state: "succeeded",
			finishedAt: "2026-09-30T12:00:00.000Z",
		};
		await Promise.all(Array.from({ length: 8 }, () => noteFinished(testDb.db, [job])));
		const rows = await testDb.db
			.selectFrom("audit_events")
			.select("target")
			.where("action", "=", "certificate.job_finished")
			.execute();
		expect(rows).toHaveLength(1);
	});
});

test("auditSummary names the provider for both settings shapes", () => {
	const directory = "https://acme.example/directory";
	expect(
		auditSummary({
			source: "acme",
			directory,
			email: "a@example.edu",
			eab: null,
			challenge: { mode: "dns01", provider: "cloudflare", fields: {}, secretsSet: {} },
		}),
	).toEqual({ source: "acme", directory, provider: "cloudflare" });
	expect(
		auditSummary({
			source: "acme",
			directory,
			email: "a@example.edu",
			eab: null,
			challenge: { mode: "http01" },
		}),
	).toEqual({ source: "acme", directory, provider: "http01" });
	expect(auditSummary({ source: "internal" })).toEqual({
		source: "internal",
		directory: null,
		provider: null,
	});
});
