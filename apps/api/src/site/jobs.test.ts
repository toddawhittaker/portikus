/**
 * The API side of the root site job (ADR 0059): request files are written
 * whole and owner-only, status is read back without the request body, and
 * the audit rows never carry a secret (SPEC.md 24.8, 24.11).
 */
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	SITE_JOB_STALE_MS,
	SiteJobRequest,
	type SiteJobView,
} from "@portikus/contracts";
import { createTestDb, hasTestDb, type TestDb } from "@portikus/db/testing";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "vitest";
import {
	allSiteJobs,
	noteSiteJobsFinished,
	queuedView,
	readSiteJob,
	requestSiteJob,
	requestSummary,
	siteJobBlock,
	siteJobLog,
} from "./jobs.js";
import { readSiteView } from "./view.js";

const ID = "11111111-2222-4333-8444-555555555555";
const SECRET = "s".repeat(24);

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "site-jobs-"));
	await mkdir(join(dir, "status"));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

async function writeStatus(id: string, body: Record<string, unknown>): Promise<void> {
	await writeFile(join(dir, "status", `${id}.json`), JSON.stringify({ id, ...body }));
}

function job(over: Partial<SiteJobView>): SiteJobView {
	return { ...queuedView(ID, null), ...over };
}

describe("reading jobs", () => {
	test("a waiting request is queued with no kind, and its body is never read", async () => {
		await writeFile(join(dir, `request-${ID}.json`), "not even JSON");
		const jobs = await allSiteJobs(dir);
		expect(jobs).toHaveLength(1);
		expect(jobs[0]).toMatchObject({ id: ID, kind: null, state: "queued" });
		expect(jobs[0]?.requestedAt).not.toBeNull();
	});

	test("a status file gives the kind, state, code and trial deadline", async () => {
		await writeStatus(ID, {
			kind: "address",
			state: "trial",
			code: null,
			startedAt: "2026-10-10T12:00:00.000Z",
			finishedAt: null,
			trialEndsAt: "2026-10-10T12:15:00.000Z",
		});
		expect(await readSiteJob(dir, ID)).toEqual({
			id: ID,
			kind: "address",
			state: "trial",
			code: null,
			requestedAt: null,
			startedAt: "2026-10-10T12:00:00.000Z",
			finishedAt: null,
			trialEndsAt: "2026-10-10T12:15:00.000Z",
		});
	});

	test("a status file naming another id, a bad code or junk is skipped", async () => {
		const other = "22222222-2222-4333-8444-555555555555";
		await writeFile(
			join(dir, "status", `${ID}.json`),
			JSON.stringify({
				id: other,
				kind: "keep",
				state: "done",
				code: null,
				startedAt: null,
				finishedAt: null,
			}),
		);
		await writeStatus(other, {
			kind: "keep",
			state: "failed",
			code: "free text from setup",
			startedAt: null,
			finishedAt: null,
		});
		await writeFile(join(dir, "status", "junk.json"), "{}");
		expect(await allSiteJobs(dir)).toEqual([]);
		expect(await readSiteJob(dir, "../etc/passwd")).toBeNull();
	});

	test("a missing directory reads as no jobs", async () => {
		expect(await allSiteJobs(join(dir, "missing"))).toEqual([]);
	});

	test("the log is the tail of status/<id>.log, and a bad id reads nothing", async () => {
		await writeFile(join(dir, "status", `${ID}.log`), "one\ntwo\nthree\n");
		expect(await siteJobLog(dir, ID, 2)).toEqual(["two", "three"]);
		expect(await siteJobLog(dir, "../x", 2)).toEqual([]);
	});
});

describe("siteJobBlock (ADR 0059)", () => {
	const NOW = Date.parse("2026-10-10T12:00:00.000Z");
	const ago = (ms: number) => new Date(NOW - ms).toISOString();

	test("a queued or running job blocks every kind", () => {
		const running = [job({ state: "running", startedAt: ago(60_000) })];
		expect(siteJobBlock("proxy-hosts", running, NOW)).toBe("busy");
		expect(siteJobBlock("keep", running, NOW)).toBe("busy");
		const queued = [job({ state: "queued", requestedAt: ago(1000) })];
		expect(siteJobBlock("signin", queued, NOW)).toBe("busy");
	});

	test("a dead job blocks nothing", () => {
		const dead = [job({ state: "running", startedAt: ago(SITE_JOB_STALE_MS + 1) })];
		expect(siteJobBlock("address", dead, NOW)).toBeNull();
	});

	test("an open trial blocks address and signin, not the rest", () => {
		const trial = [job({ kind: "signin", state: "trial" })];
		expect(siteJobBlock("address", trial, NOW)).toBe("trial_open");
		expect(siteJobBlock("signin", trial, NOW)).toBe("trial_open");
		expect(siteJobBlock("keep", trial, NOW)).toBeNull();
		expect(siteJobBlock("rollback", trial, NOW)).toBeNull();
		expect(siteJobBlock("proxy-hosts", trial, NOW)).toBeNull();
		expect(siteJobBlock("lti-platforms", trial, NOW)).toBeNull();
	});
});

test("requestSummary never carries the client secret", () => {
	const summary = requestSummary({
		kind: "signin",
		provider: "oidc",
		oidcIssuer: "https://login.example.edu",
		clientId: "portikus",
		clientSecret: SECRET,
	});
	expect(JSON.stringify(summary)).not.toContain(SECRET);
	expect(summary).toMatchObject({ provider: "oidc", clientSecretChanged: true });
});

test("readSiteView tolerates a missing or malformed file", async () => {
	expect(await readSiteView(join(dir, "missing.json"))).toBeNull();
	const path = join(dir, "site-view.json");
	await writeFile(path, "{ not json");
	expect(await readSiteView(path)).toBeNull();
	const view = {
		version: 1,
		apt: true,
		host: "portikus.example.edu",
		port: 443,
		previewSuffix: "preview.portikus.example.edu",
		previewSuffixSetByHand: false,
		provider: "dex",
		entraTenantId: null,
		googleDomains: [],
		oidcIssuer: null,
		clientId: null,
		clientSecretSet: false,
		groupsClaim: null,
		groups: { student: "s", instructor: "i", admin: "a" },
		certificateSource: "acme",
	};
	await writeFile(path, JSON.stringify(view));
	expect(await readSiteView(path)).toEqual(view);
	await writeFile(path, JSON.stringify({ ...view, clientSecret: SECRET }));
	expect(await readSiteView(path)).toBeNull();
});

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

describe.skipIf(skip)("with the database", () => {
	beforeEach(async () => {
		await testDb.truncate();
	});

	test("requestSiteJob writes one 0600 request the job's schema accepts, and a secret-free audit row", async () => {
		const queued = await requestSiteJob(testDb.db, dir, "user:admin", {
			kind: "signin",
			provider: "oidc",
			oidcIssuer: "https://login.example.edu/realms/main",
			clientId: "portikus",
			clientSecret: SECRET,
		});
		expect(queued).toMatchObject({ state: "queued", kind: null });
		const names = (await readdir(dir)).filter((n) => n !== "status");
		expect(names).toEqual([`request-${queued.id}.json`]);
		const path = join(dir, `request-${queued.id}.json`);
		expect((await stat(path)).mode & 0o777).toBe(0o600);
		const parsed = SiteJobRequest.parse(JSON.parse(await readFile(path, "utf8")));
		expect(parsed).toMatchObject({ version: 1, id: queued.id, kind: "signin" });

		const rows = await testDb.db
			.selectFrom("audit_events")
			.selectAll()
			.where("action", "=", "site.job_requested")
			.execute();
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ actor: "user:admin", target: queued.id });
		expect(JSON.stringify(rows[0])).not.toContain(SECRET);
		expect((await allSiteJobs(dir)).map((j) => j.id)).toEqual([queued.id]);
	});

	test("site.job_finished is written once per ended job, even for concurrent callers", async () => {
		const ended = job({ kind: "address", state: "reverted", code: "trial_expired" });
		const open = job({
			id: "33333333-2222-4333-8444-555555555555",
			kind: "signin",
			state: "trial",
		});
		await Promise.all(
			Array.from({ length: 8 }, () => noteSiteJobsFinished(testDb.db, [ended, open])),
		);
		const rows = await testDb.db
			.selectFrom("audit_events")
			.selectAll()
			.where("action", "=", "site.job_finished")
			.execute();
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ actor: "site-job", target: ID, result: "ok" });
		expect(rows[0]?.metadata).toEqual({
			kind: "address",
			state: "reverted",
			code: "trial_expired",
		});
	});
});
