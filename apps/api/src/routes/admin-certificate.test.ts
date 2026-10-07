/**
 * The Certificate routes (docs/SPEC.md sections 20.1, 22.4, 24.8 and 24.11).
 * Administrator-only and CSRF-checked; the API writes nothing but one 0600
 * request file, refuses a second job, keeps stored secrets when a field is
 * blank, and no secret ever comes back out in a response, a log line or an
 * audit row.
 */
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	stat,
	utimes,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOidcClient } from "@portikus/auth";
import {
	CookieJar,
	csrfHeaders,
	loginAs,
	type MockOidcProvider,
	startMockOidcProvider,
} from "@portikus/auth/testing";
import {
	CERTIFICATE_JOB_STALE_MS,
	type CertificateJobRecord,
	type CertificateJobStatusFile,
	type CertificateSettingsView,
	type CertificateStatusFile,
} from "@portikus/contracts";
import { createTestDb, hasTestDb, type TestDb } from "@portikus/db/testing";
import { createLogger } from "@portikus/observability";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { toAuthOptions } from "../auth-options.js";
import type { PreflightNet } from "../certificate/preflight.js";
import { buildServer } from "../server.js";
import { PUBLIC_URL, testConfig } from "../testing/test-support.js";
import { uploadsToCheck } from "./admin-certificate.js";

const skip = !hasTestDb();

const SECRET = "FAKE-dns-token-for-tests-0001";
const HMAC = "FAKE-hmac-key-for-tests-0002";
// Built in pieces so the secret scanner does not take the fake for a key.
const KEY_LABEL = ["PRIVATE", "KEY"].join(" ");
const KEY_PEM = `-----BEGIN ${KEY_LABEL}-----\nFAKEKEYFORTESTS0003\n-----END ${KEY_LABEL}-----\n`;
const SITE = new URL(PUBLIC_URL).hostname;
const NOW = "2026-09-30T12:00:00.000Z";
const JOB = "22222222-2222-4222-8222-222222222222";
const RESET_JOB = "33333333-3333-4333-8333-333333333333";
const ROOT_PEM = "-----BEGIN CERTIFICATE-----\nROOT\n-----END CERTIFICATE-----\n";

let testDb: TestDb;
let mock: MockOidcProvider;
let app: FastifyInstance;
let root: string;
let jobsDir: string;
let statusDir: string;
let alice: CookieJar;
let carol: CookieJar;
let logLines: string[];
/** Whether the fake DNS resolves anything; the probe asks the app itself. */
let dnsWorks: boolean;

const acmeDns = (fields: Record<string, string>) => ({
	source: "acme",
	directory: "https://acme-staging-v02.api.letsencrypt.org/directory",
	email: "admin@example.edu",
	challenge: { mode: "dns01", dns: { provider: "cloudflare", fields } },
});

const storedCloudflare: CertificateSettingsView = {
	source: "acme",
	directory: "https://acme-v02.api.letsencrypt.org/directory",
	email: "admin@example.edu",
	eab: { keyId: "kid", hmacKeySet: true },
	challenge: {
		mode: "dns01",
		provider: "cloudflare",
		fields: {},
		secretsSet: { api_token: true },
	},
};

async function putStatus(over: Partial<CertificateStatusFile> = {}) {
	const status: CertificateStatusFile = {
		checkedAt: NOW,
		source: "internal",
		settings: { source: "internal" },
		previousAvailable: false,
		site: null,
		preview: null,
		lastRenewal: null,
		...over,
	};
	await writeFile(join(statusDir, "status.json"), JSON.stringify(status));
}

async function putJob(
	status: CertificateJobStatusFile,
	record: CertificateJobRecord | null,
) {
	await mkdir(join(jobsDir, status.id), { recursive: true });
	await writeFile(join(jobsDir, status.id, "status.json"), JSON.stringify(status));
	if (record) {
		await writeFile(join(jobsDir, status.id, "request.json"), JSON.stringify(record));
	}
	await writeFile(join(jobsDir, status.id, "log.txt"), "step one\nstep two\n");
}

function jobStatus(
	over: Partial<CertificateJobStatusFile> = {},
): CertificateJobStatusFile {
	return {
		id: JOB,
		kind: "apply",
		state: "running",
		step: "Testing with the staging directory",
		message: null,
		restored: false,
		startedAt: NOW,
		finishedAt: null,
		...over,
	} as CertificateJobStatusFile;
}

function send(
	jar: CookieJar | null,
	method: "GET" | "POST",
	url: string,
	payload?: unknown,
) {
	return app.inject({
		method,
		url,
		headers: jar ? csrfHeaders(jar, PUBLIC_URL) : {},
		...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
	});
}

async function requestFiles() {
	return (await readdir(jobsDir)).filter((name) => name.startsWith("request-"));
}

async function audits(action: string) {
	return testDb.db
		.selectFrom("audit_events")
		.selectAll()
		.where("action", "=", action)
		.execute();
}

/** Everything a secret could leak into: every log line and every audit row. */
async function leakSurface(): Promise<string> {
	const rows = await testDb.db.selectFrom("audit_events").selectAll().execute();
	return `${logLines.join("\n")}\n${JSON.stringify(rows)}`;
}

beforeAll(async () => {
	if (skip) return;
	testDb = await createTestDb();
	mock = await startMockOidcProvider({ redirectUris: [`${PUBLIC_URL}/auth/callback`] });
});

afterAll(async () => {
	if (skip) return;
	await testDb.close();
	await mock.close();
});

beforeEach(async () => {
	if (skip) return;
	await testDb.truncate();
	root = await mkdtemp(join(tmpdir(), "portikus-certificate-"));
	jobsDir = join(root, "certificate-jobs");
	statusDir = join(root, "certificate");
	await mkdir(jobsDir);
	await mkdir(statusDir);
	await putStatus();
	logLines = [];
	dnsWorks = true;
	const config = testConfig(mock.issuer, { CERTIFICATE_JOBS_DIR: jobsDir });
	const net: PreflightNet = {
		resolve: async () => (dnsWorks ? ["192.0.2.10"] : []),
		probe: async (url) => {
			const res = await app.inject({ method: "GET", url: new URL(url).pathname });
			return res.statusCode === 200 ? res.body : null;
		},
	};
	app = buildServer({
		db: testDb.db,
		config,
		logger: createLogger({
			service: "api",
			level: "debug",
			destination: { write: (line: string) => logLines.push(line) },
		}),
		oidc: createOidcClient(toAuthOptions(config)),
		certificateNet: net,
	});
	await app.listen({ port: 0, host: "127.0.0.1" });
	alice = new CookieJar();
	carol = new CookieJar();
	await loginAs(app, "alice", alice);
	await loginAs(app, "carol", carol);
	return async () => {
		await app.close();
		await rm(root, { recursive: true, force: true });
	};
});

describe.skipIf(skip)("GET /admin/certificate", () => {
	test("shows the settings, status and job the root job wrote", async () => {
		await putStatus({
			settings: storedCloudflare,
			source: "acme",
			previousAvailable: true,
		});
		await writeFile(join(statusDir, "root.crt"), ROOT_PEM);
		await putJob(jobStatus(), { kind: "apply", settings: storedCloudflare });
		const res = await send(carol, "GET", "/admin/certificate");
		expect(res.statusCode).toBe(200);
		const body = res.json();
		expect(body.siteName).toBe(SITE);
		expect(body.previewSuffix).toBe("preview.localhost");
		expect(body.settings).toEqual(storedCloudflare);
		expect(body.previousAvailable).toBe(true);
		expect(body.rootCertificateAvailable).toBe(true);
		expect(body.job.id).toBe(JOB);
		expect(body.job.state).toBe("running");
	});

	test("is administrator-only", async () => {
		expect((await send(alice, "GET", "/admin/certificate")).statusCode).toBe(403);
		expect((await send(null, "GET", "/admin/certificate")).statusCode).toBe(401);
	});

	test("audits each finished job once, the reset command's too, without secrets", async () => {
		await putJob(
			jobStatus({
				state: "failed",
				message: "token refused",
				restored: true,
				finishedAt: NOW,
			}),
			{
				kind: "apply",
				settings: storedCloudflare,
			},
		);
		await putJob(
			jobStatus({ id: RESET_JOB, kind: "reset", state: "succeeded", finishedAt: NOW }),
			null,
		);
		await send(carol, "GET", "/admin/certificate");
		await send(carol, "GET", "/admin/certificate");
		const rows = await audits("certificate.job_finished");
		expect(rows).toHaveLength(2);
		const apply = rows.find((r) => r.target === JOB);
		expect(apply?.result).toBe("failed");
		expect(apply?.metadata).toEqual({
			kind: "apply",
			source: "acme",
			directory: storedCloudflare.source === "acme" ? storedCloudflare.directory : null,
			provider: "cloudflare",
			state: "failed",
		});
		expect(rows.find((r) => r.target === RESET_JOB)?.actor).toBe("reset-certificate");
	});
});

describe.skipIf(skip)("GET /admin/certificate/jobs/:id", () => {
	test("returns the job and its log", async () => {
		await putJob(jobStatus(), { kind: "apply", settings: { source: "internal" } });
		const res = await send(carol, "GET", `/admin/certificate/jobs/${JOB}`);
		expect(res.statusCode).toBe(200);
		expect(res.json().log).toEqual(["step one", "step two"]);
		expect(res.json().job.request).toEqual({
			kind: "apply",
			settings: { source: "internal" },
		});
	});

	test("refuses a bad id and an unknown job", async () => {
		expect((await send(carol, "GET", "/admin/certificate/jobs/nope")).statusCode).toBe(
			400,
		);
		expect(
			(await send(carol, "GET", `/admin/certificate/jobs/${JOB}`)).statusCode,
		).toBe(404);
	});
});

describe.skipIf(skip)("POST /admin/certificate/jobs", () => {
	test("writes one owner-only request file by rename and audits it", async () => {
		const res = await send(carol, "POST", "/admin/certificate/jobs", {
			kind: "apply",
			settings: { source: "internal" },
		});
		expect(res.statusCode).toBe(202);
		expect(res.json().state).toBe("queued");
		const files = await readdir(jobsDir);
		expect(files.filter((f) => f.endsWith(".tmp"))).toEqual([]);
		const [name] = await requestFiles();
		expect(name).toBe(`request-${res.json().id}.json`);
		const path = join(jobsDir, name as string);
		expect((await stat(path)).mode & 0o777).toBe(0o600);
		const file = JSON.parse(await readFile(path, "utf8"));
		expect(file.request).toEqual({ kind: "apply", settings: { source: "internal" } });
		const [row] = await audits("certificate.job_requested");
		expect(row?.metadata).toEqual({
			kind: "apply",
			source: "internal",
			directory: null,
			provider: null,
		});
	});

	test("sweeps a stale temp request file before writing, since it may hold secrets", async () => {
		await mkdir(jobsDir, { recursive: true });
		await writeFile(join(jobsDir, ".request-stale.tmp"), "{}");
		const res = await send(carol, "POST", "/admin/certificate/jobs", {
			kind: "apply",
			settings: { source: "internal" },
		});
		expect(res.statusCode).toBe(202);
		expect((await readdir(jobsDir)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
	});

	test("a stale queued request is removed before the new one is written", async () => {
		const stale = join(jobsDir, "request-55555555-5555-4555-8555-555555555555.json");
		await writeFile(stale, "{}");
		const old = new Date(Date.now() - CERTIFICATE_JOB_STALE_MS - 60_000);
		await utimes(stale, old, old);
		const res = await send(carol, "POST", "/admin/certificate/jobs", { kind: "check" });
		expect(res.statusCode).toBe(202);
		expect(await requestFiles()).toEqual([`request-${res.json().id}.json`]);
	});

	test("refuses a second job while one waits or runs", async () => {
		const first = await send(carol, "POST", "/admin/certificate/jobs", {
			kind: "check",
		});
		expect(first.statusCode).toBe(202);
		const second = await send(carol, "POST", "/admin/certificate/jobs", {
			kind: "check",
		});
		expect(second.statusCode).toBe(409);
		expect(second.json().code).toBe("CERTIFICATE_JOB_BUSY");
		await rm(join(jobsDir, `request-${first.json().id}.json`));
		await putJob(jobStatus({ startedAt: new Date().toISOString() }), null);
		const third = await send(carol, "POST", "/admin/certificate/jobs", {
			kind: "check",
		});
		expect(third.statusCode).toBe(409);
	});

	test("a job killed while running stops blocking once stale, and the page shows the job before it", async () => {
		const longAgo = (ms: number) => new Date(Date.now() - ms).toISOString();
		const earlier = "44444444-4444-4444-8444-444444444444";
		await putJob(
			jobStatus({
				id: earlier,
				kind: "check",
				state: "succeeded",
				step: "Done",
				startedAt: longAgo(CERTIFICATE_JOB_STALE_MS + 60_000),
				finishedAt: longAgo(CERTIFICATE_JOB_STALE_MS + 30_000),
			}),
			null,
		);
		await putJob(
			jobStatus({ startedAt: longAgo(CERTIFICATE_JOB_STALE_MS + 1000) }),
			null,
		);
		const page = await send(carol, "GET", "/admin/certificate");
		expect(page.json().job).toMatchObject({ id: earlier, state: "succeeded" });
		const res = await send(carol, "POST", "/admin/certificate/jobs", { kind: "check" });
		expect(res.statusCode).toBe(202);
	});

	test("is administrator-only", async () => {
		const res = await send(alice, "POST", "/admin/certificate/jobs", { kind: "check" });
		expect(res.statusCode).toBe(403);
		expect(await requestFiles()).toEqual([]);
	});

	test("a blank secret keeps the stored one; the secret never comes back out", async () => {
		await putStatus({ settings: storedCloudflare, source: "acme" });
		const res = await send(carol, "POST", "/admin/certificate/jobs", {
			kind: "apply",
			settings: { ...acmeDns({ api_token: "" }), eab: { keyId: "kid", hmacKey: "" } },
		});
		expect(res.statusCode).toBe(202);
		const [name] = await requestFiles();
		const file = JSON.parse(await readFile(join(jobsDir, name as string), "utf8"));
		expect(file.request.settings.challenge.dns.fields).toEqual({});
		expect(file.request.settings.eab).toEqual({ keyId: "kid" });
	});

	test("a blank secret with nothing stored is refused", async () => {
		const res = await send(carol, "POST", "/admin/certificate/jobs", {
			kind: "apply",
			settings: acmeDns({}),
		});
		expect(res.statusCode).toBe(400);
		expect(res.json().code).toBe("CERTIFICATE_SECRET_REQUIRED");
		expect(res.json().message).toContain("api_token");
		const eab = await send(carol, "POST", "/admin/certificate/jobs", {
			kind: "apply",
			settings: { ...acmeDns({ api_token: SECRET }), eab: { keyId: "kid" } },
		});
		expect(eab.json().code).toBe("CERTIFICATE_SECRET_REQUIRED");
		expect(await requestFiles()).toEqual([]);
	});

	test("secrets reach only the request file: not a response, a log line or an audit row", async () => {
		const res = await send(carol, "POST", "/admin/certificate/jobs", {
			kind: "apply",
			settings: {
				...acmeDns({ api_token: SECRET }),
				eab: { keyId: "kid", hmacKey: HMAC },
			},
		});
		expect(res.statusCode).toBe(202);
		const [name] = await requestFiles();
		expect(await readFile(join(jobsDir, name as string), "utf8")).toContain(SECRET);
		const view = await send(carol, "GET", "/admin/certificate");
		const job = await send(carol, "GET", `/admin/certificate/jobs/${res.json().id}`);
		for (const text of [res.body, view.body, job.body, await leakSurface()]) {
			expect(text).not.toContain(SECRET);
			expect(text).not.toContain(HMAC);
		}
	});

	test("a refused body names fields, never their values", async () => {
		const res = await send(carol, "POST", "/admin/certificate/jobs", {
			kind: "apply",
			settings: acmeDns({ api_token: `${SECRET}\nsecond line` }),
		});
		expect(res.statusCode).toBe(400);
		expect(res.body).not.toContain(SECRET);
		expect(res.json().message).toContain("api_token");
		const upload = await send(carol, "POST", "/admin/certificate/jobs", {
			kind: "apply",
			settings: {
				source: "files",
				site: {
					certificate: "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n",
					privateKey: KEY_PEM,
				},
			},
		});
		expect(upload.statusCode).toBe(400);
		expect(upload.json().code).toBe("CERTIFICATE_UPLOAD_REFUSED");
		expect(upload.json().message).toContain("certificate-readable");
		for (const text of [upload.body, await leakSurface()]) {
			expect(text).not.toContain("FAKEKEYFORTESTS0003");
			expect(text).not.toContain(SECRET);
		}
	});

	test("pre-flight failures block HTTP-01", async () => {
		dnsWorks = false;
		const res = await send(carol, "POST", "/admin/certificate/jobs", {
			kind: "test",
			settings: { ...acmeDns({}), challenge: { mode: "http01" } },
		});
		expect(res.statusCode).toBe(409);
		expect(res.json().code).toBe("CERTIFICATE_PREFLIGHT_FAILED");
		expect(await requestFiles()).toEqual([]);
	});

	test("pre-flight failures only warn for DNS-01", async () => {
		dnsWorks = false;
		const res = await send(carol, "POST", "/admin/certificate/jobs", {
			kind: "test",
			settings: acmeDns({ api_token: SECRET }),
		});
		expect(res.statusCode).toBe(202);
	});

	test("rollback needs an earlier generation", async () => {
		const res = await send(carol, "POST", "/admin/certificate/jobs", {
			kind: "rollback",
		});
		expect(res.statusCode).toBe(409);
		expect(res.json().code).toBe("CERTIFICATE_NO_PREVIOUS");
		await putStatus({ previousAvailable: true });
		const ok = await send(carol, "POST", "/admin/certificate/jobs", {
			kind: "rollback",
		});
		expect(ok.statusCode).toBe(202);
	});
});

describe.skipIf(skip)("POST /admin/certificate/preflight", () => {
	test("each name passes when DNS resolves and the nonce comes back", async () => {
		const res = await send(carol, "POST", "/admin/certificate/preflight", {
			mode: "http01",
		});
		expect(res.statusCode).toBe(200);
		expect(res.json().ok).toBe(true);
		expect(res.json().checks).toHaveLength(5);
	});

	test("is administrator-only", async () => {
		const res = await send(alice, "POST", "/admin/certificate/preflight", {
			mode: "dns01",
		});
		expect(res.statusCode).toBe(403);
	});

	test("the nonce route answers only a live nonce", async () => {
		const res = await app.inject({
			method: "GET",
			url: "/.well-known/portikus-preflight/0123456789abcdef0123456789abcdef",
		});
		expect(res.statusCode).toBe(404);
	});
});

describe.skipIf(skip)("GET /admin/certificate/root.crt", () => {
	test("serves the internal root to administrators only", async () => {
		expect((await send(carol, "GET", "/admin/certificate/root.crt")).statusCode).toBe(
			404,
		);
		await writeFile(join(statusDir, "root.crt"), ROOT_PEM);
		const res = await send(carol, "GET", "/admin/certificate/root.crt");
		expect(res.statusCode).toBe(200);
		expect(res.body).toBe(ROOT_PEM);
		expect(res.headers["content-disposition"]).toContain("attachment");
		expect((await send(alice, "GET", "/admin/certificate/root.crt")).statusCode).toBe(
			403,
		);
		expect((await send(null, "GET", "/admin/certificate/root.crt")).statusCode).toBe(
			401,
		);
	});
});

describe.skipIf(skip)("GET /edge/certificate-ask", () => {
	const ask = (domain: string, remoteAddress = "127.0.0.1") =>
		app.inject({
			method: "GET",
			url: `/edge/certificate-ask?domain=${encodeURIComponent(domain)}`,
			remoteAddress,
		});

	test("allows the site; a preview host with nothing listening is refused", async () => {
		const ws = await send(alice, "POST", "/workspaces");
		const { label } = await testDb.db
			.selectFrom("workspaces")
			.select("label")
			.where("id", "=", ws.json().id)
			.executeTakeFirstOrThrow();
		expect((await ask(SITE)).statusCode).toBe(200);
		expect((await ask(`${label}-3000.preview.localhost`)).statusCode).toBe(404);
		expect((await ask(`${label}-3000.PREVIEW.localhost`)).statusCode).toBe(404);
		expect((await ask(`nobody-3000.preview.localhost`)).statusCode).toBe(404);
		expect((await ask(`${label}-22.preview.localhost`)).statusCode).toBe(404);
		expect((await ask(`x.${label}-3000.preview.localhost`)).statusCode).toBe(404);
		expect((await ask("example.com")).statusCode).toBe(404);
		expect(
			(await app.inject({ method: "GET", url: "/edge/certificate-ask" })).statusCode,
		).toBe(404);
	});

	test("answers only Caddy on this machine", async () => {
		expect((await ask(SITE, "203.0.113.9")).statusCode).toBe(403);
	});
});

describe("uploadsToCheck", () => {
	const site = { certificate: "site", privateKey: "site-key" };
	const preview = { certificate: "preview", privateKey: "preview-key" };

	test("one certificate must cover the site and the preview wildcard", () => {
		expect(
			uploadsToCheck(
				{ source: "files", site },
				"portikus.example.edu",
				"p.example.edu",
			),
		).toEqual([
			{
				label: "Site certificate",
				upload: site,
				names: ["portikus.example.edu", "*.p.example.edu"],
			},
		]);
	});

	test("a separate preview certificate covers only the wildcard", () => {
		expect(
			uploadsToCheck(
				{ source: "files", site, preview },
				"portikus.example.edu",
				"p.example.edu",
			),
		).toEqual([
			{ label: "Site certificate", upload: site, names: ["portikus.example.edu"] },
			{ label: "Preview certificate", upload: preview, names: ["*.p.example.edu"] },
		]);
	});
});
