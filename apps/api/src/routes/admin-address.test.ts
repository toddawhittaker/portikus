/**
 * The Site address routes (SPEC.md 20.1, ADR 0059): plan,
 * pre-flight, a trial applied by the root site job, Keep only from the new
 * address, roll back, apt installs only, and uploaded certificates that must
 * cover the new names. The root job is played by writing its status files.
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
import { createOidcClient } from "@portikus/auth";
import {
	CookieJar,
	csrfHeaders,
	loginAs,
	type MockOidcProvider,
	startMockOidcProvider,
} from "@portikus/auth/testing";
import {
	AddressPlan,
	AdminAddress,
	CertificatePreflight,
	type CertificateStatusFile,
	type SiteJobRequest,
	type SiteJobStatusFile,
	type SiteView,
} from "@portikus/contracts";
import { createTestDb, hasTestDb, type TestDb } from "@portikus/db/testing";
import { silentLogger } from "@portikus/observability";
import type { FastifyInstance } from "fastify";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "vitest";
import { toAuthOptions } from "../auth-options.js";
import type { PreflightNet } from "../certificate/preflight.js";
import { buildServer } from "../server.js";
import { PUBLIC_URL, testConfig } from "../testing/test-support.js";

const skip = !hasTestDb();
let testDb: TestDb;
let mock: MockOidcProvider;
let dir = "";
let jobsDir = "";
let viewFile = "";
let certJobsDir = "";

const VIEW: SiteView = {
	version: 1,
	apt: true,
	host: "portikus.example.edu",
	port: 8443,
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
	certificateSource: "internal",
};
const NEW = { host: "code.example.edu", port: 443 };
const THIS_SERVER = "192.0.2.10";

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
	dir = await mkdtemp(join(tmpdir(), "admin-address-"));
	jobsDir = join(dir, "site-jobs");
	viewFile = join(dir, "site-view.json");
	certJobsDir = join(dir, "certificate-jobs");
	await mkdir(join(jobsDir, "status"), { recursive: true });
	await writeView(VIEW);
});

afterEach(async () => {
	if (dir) await rm(dir, { recursive: true, force: true });
});

async function writeView(view: SiteView): Promise<void> {
	await writeFile(viewFile, JSON.stringify(view));
}

/** DNS where `pointsHere` decides which names resolve to this server; this server answers every nonce. */
function fakeNet(pointsHere: (name: string) => boolean): PreflightNet {
	return {
		resolve: async (name) => [pointsHere(name) ? THIS_SERVER : "198.51.100.7"],
		probe: async (url, address) =>
			address === THIS_SERVER ? (new URL(url).pathname.split("/").pop() ?? null) : null,
	};
}

function server(
	overrides: Record<string, unknown> = {},
	net: PreflightNet = fakeNet(() => true),
): FastifyInstance {
	const config = testConfig(mock.issuer, {
		SITE_JOBS_DIR: jobsDir,
		SITE_VIEW_FILE: viewFile,
		CERTIFICATE_JOBS_DIR: certJobsDir,
		...overrides,
	});
	return buildServer({
		db: testDb.db,
		config,
		logger: silentLogger(),
		oidc: createOidcClient(toAuthOptions(config)),
		certificateNet: net,
	});
}

async function as(app: FastifyInstance, who: string) {
	const jar = new CookieJar();
	await loginAs(app, who, jar);
	return (method: "GET" | "POST", url: string, payload?: unknown, host?: string) =>
		app.inject({
			method,
			url,
			headers: { ...csrfHeaders(jar, PUBLIC_URL), ...(host ? { host } : {}) },
			...(payload === undefined ? {} : { payload: payload as object }),
		});
}

async function requests(): Promise<string[]> {
	return (await readdir(jobsDir)).filter((n) => n.startsWith("request-"));
}

/** Take the one request file, as the root job does, and write its status. */
async function playJob(
	state: SiteJobStatusFile["state"],
	code: SiteJobStatusFile["code"] = null,
): Promise<SiteJobRequest> {
	const [name] = await requests();
	if (!name) throw new Error("no request file");
	const request = JSON.parse(
		await readFile(join(jobsDir, name), "utf8"),
	) as SiteJobRequest;
	await rm(join(jobsDir, name));
	await writeStatus({ id: request.id, kind: request.kind, state, code });
	return request;
}

async function writeStatus(
	status: Pick<SiteJobStatusFile, "id" | "kind" | "state" | "code">,
): Promise<void> {
	const now = new Date().toISOString();
	const file: SiteJobStatusFile = {
		...status,
		startedAt: now,
		finishedAt: status.state === "trial" ? null : now,
		trialEndsAt:
			status.state === "trial"
				? new Date(Date.now() + 15 * 60_000).toISOString()
				: null,
	};
	await writeFile(join(jobsDir, "status", `${status.id}.json`), JSON.stringify(file));
}

/** Apply the new address and let the job open its trial. */
async function openTrial(
	call: Awaited<ReturnType<typeof as>>,
): Promise<SiteJobRequest> {
	expect((await call("POST", "/admin/address/apply", NEW)).statusCode).toBe(202);
	return playJob("trial");
}

async function writeUploadedCertificate(names: string[]): Promise<void> {
	const statusDir = join(dir, "certificate");
	await mkdir(statusDir, { recursive: true });
	const certificate = {
		issuer: "Campus CA",
		names,
		notBefore: "2026-01-01T00:00:00.000Z",
		notAfter: "2027-01-01T00:00:00.000Z",
	};
	const status: CertificateStatusFile = {
		checkedAt: new Date().toISOString(),
		source: "files",
		settings: {
			source: "files",
			site: { certificate, privateKeySet: true },
			preview: null,
		},
		previousAvailable: false,
		site: null,
		preview: null,
		lastRenewal: null,
	};
	await writeFile(join(statusDir, "status.json"), JSON.stringify(status));
}

describe.skipIf(skip)("admin address routes", () => {
	test("are 404 without SITE_JOBS_DIR", async () => {
		const app = server({ SITE_JOBS_DIR: undefined });
		const call = await as(app, "carol");
		expect((await call("GET", "/admin/address")).statusCode).toBe(404);
		expect((await call("POST", "/admin/address/apply", NEW)).statusCode).toBe(404);
		await app.close();
	});

	test("refuse students", async () => {
		const app = server();
		const call = await as(app, "alice");
		expect((await call("GET", "/admin/address")).statusCode).toBe(403);
		expect((await call("POST", "/admin/address/apply", NEW)).statusCode).toBe(403);
		expect(await requests()).toEqual([]);
		await app.close();
	});

	test("GET shows the current address, apt and the certificate source", async () => {
		const app = server();
		const call = await as(app, "carol");
		const body = AdminAddress.parse((await call("GET", "/admin/address")).json());
		expect(body).toEqual({
			current: {
				host: VIEW.host,
				port: VIEW.port,
				previewSuffix: VIEW.previewSuffix,
				previewSuffixSetByHand: false,
				certificateSource: "internal",
			},
			apt: true,
			target: null,
			job: null,
		});
		await app.close();
	});

	test("off apt installs nothing can be applied", async () => {
		await writeView({ ...VIEW, apt: false });
		const app = server();
		const call = await as(app, "carol");
		const body = AdminAddress.parse((await call("GET", "/admin/address")).json());
		expect(body).toMatchObject({ current: null, apt: false });
		for (const path of ["plan", "preflight", "apply"]) {
			const res = await call("POST", `/admin/address/${path}`, NEW);
			expect(res.statusCode).toBe(409);
			expect(res.json().code).toBe("NOT_IMPLEMENTED");
		}
		await rm(viewFile);
		expect((await call("POST", "/admin/address/apply", NEW)).statusCode).toBe(409);
		expect(await requests()).toEqual([]);
		await app.close();
	});

	test("refuse a bad host, a reserved port and the address in force", async () => {
		const app = server();
		const call = await as(app, "carol");
		for (const body of [
			{ host: "{{ 7*7 }}", port: 443 },
			{ host: "192.0.2.1", port: 443 },
			{ host: "code.example.edu", port: 5432 },
			{ host: VIEW.host, port: VIEW.port },
		]) {
			const res = await call("POST", "/admin/address/apply", body);
			expect(res.statusCode).toBe(400);
			expect(res.json().message).not.toContain("{{");
		}
		expect(await requests()).toEqual([]);
		await app.close();
	});

	test("plan lists the new values and the running workspaces", async () => {
		for (const [label, state] of [
			["ola", "running"],
			["pat", "stopped"],
		] as const) {
			const owner = await testDb.db
				.insertInto("users")
				.values({
					oidc_issuer: "https://test.invalid",
					oidc_subject: label,
					display_name: `${label} owner`,
					role: "student",
				})
				.returning("id")
				.executeTakeFirstOrThrow();
			await testDb.db
				.insertInto("workspaces")
				.values({ owner_user_id: owner.id, label, state })
				.execute();
		}
		const app = server();
		const call = await as(app, "carol");
		const res = await call("POST", "/admin/address/plan", NEW);
		expect(res.statusCode).toBe(200);
		const plan = AddressPlan.parse(res.json());
		expect(plan.dexIssuer).toBe("https://code.example.edu/dex");
		expect(plan.previewWildcard).toBe("*.preview.code.example.edu");
		expect(plan.workspacesKeepingOldSuffix).toEqual([
			expect.objectContaining({ label: "ola", ownerName: "ola owner" }),
		]);
		expect(await requests()).toEqual([]);
		await app.close();
	});

	test("pre-flight refuses a name whose DNS does not point here", async () => {
		const app = server(
			{},
			fakeNet((name) => name !== NEW.host),
		);
		const call = await as(app, "carol");
		const res = await call("POST", "/admin/address/preflight", NEW);
		const result = CertificatePreflight.parse(res.json());
		expect(result.ok).toBe(false);
		expect(result.checks.find((c) => c.name === "reach-site")?.result).toBe("failed");
		await app.close();
	});

	test("pre-flight passes when both names point here", async () => {
		const app = server();
		const call = await as(app, "carol");
		const result = CertificatePreflight.parse(
			(await call("POST", "/admin/address/preflight", NEW)).json(),
		);
		expect(result.ok).toBe(true);
		await app.close();
	});

	test("apply writes an owner-only address request and audits it", async () => {
		const app = server();
		const call = await as(app, "carol");
		const res = await call("POST", "/admin/address/apply", NEW);
		expect(res.statusCode).toBe(202);
		expect(res.json()).toMatchObject({ state: "queued", kind: "address" });
		const [name] = await requests();
		if (!name) throw new Error("no request");
		expect((await stat(join(jobsDir, name))).mode & 0o777).toBe(0o600);
		expect(JSON.parse(await readFile(join(jobsDir, name), "utf8"))).toMatchObject({
			kind: "address",
			...NEW,
		});
		const audit = await testDb.db
			.selectFrom("audit_events")
			.select(["action", "metadata"])
			.where("action", "=", "site.job_requested")
			.execute();
		expect(audit).toEqual([
			{ action: "site.job_requested", metadata: { kind: "address", ...NEW } },
		]);
		// The queued request shows on the page with the address it asked for.
		const view = AdminAddress.parse((await call("GET", "/admin/address")).json());
		expect(view.job).toMatchObject({ state: "queued", kind: "address" });
		expect(view.target).toEqual(NEW);
		await app.close();
	});

	test("a trial blocks another change, and Keep works only from the new address", async () => {
		const app = server();
		const call = await as(app, "carol");
		const trial = await openTrial(call);
		const view = AdminAddress.parse((await call("GET", "/admin/address")).json());
		expect(view.job).toMatchObject({ id: trial.id, state: "trial", kind: "address" });
		expect(view.job?.trialEndsAt).not.toBeNull();
		expect(view.target).toEqual(NEW);

		const again = await call("POST", "/admin/address/apply", {
			host: "other.example.edu",
			port: 443,
		});
		expect(again.statusCode).toBe(409);
		expect(again.json().code).toBe("SITE_JOB_BUSY");

		// The old address cannot prove the new one works.
		const fromOld = await call(
			"POST",
			"/admin/address/keep",
			undefined,
			"portikus.example.edu:8443",
		);
		expect(fromOld.statusCode).toBe(403);
		expect(fromOld.json().message).toContain("https://code.example.edu");
		expect(await requests()).toEqual([]);

		const fromNew = await call(
			"POST",
			"/admin/address/keep",
			undefined,
			"code.example.edu",
		);
		expect(fromNew.statusCode).toBe(202);
		const keep = await playJob("done");
		expect(keep).toMatchObject({ kind: "keep", trialId: trial.id });
		await app.close();
	});

	test("Keep accepts the new address with an explicit :443", async () => {
		const app = server();
		const call = await as(app, "carol");
		await openTrial(call);
		const res = await call(
			"POST",
			"/admin/address/keep",
			undefined,
			"code.example.edu:443",
		);
		expect(res.statusCode).toBe(202);
		await app.close();
	});

	test("roll back works from any address", async () => {
		const app = server();
		const call = await as(app, "carol");
		const trial = await openTrial(call);
		const res = await call("POST", "/admin/address/rollback");
		expect(res.statusCode).toBe(202);
		expect(await playJob("done")).toMatchObject({
			kind: "rollback",
			trialId: trial.id,
		});
		// The job marks the trial reverted; nothing is left to keep.
		await writeStatus({
			id: trial.id,
			kind: "address",
			state: "reverted",
			code: "rolled_back",
		});
		const keep = await call(
			"POST",
			"/admin/address/keep",
			undefined,
			"code.example.edu",
		);
		expect(keep.statusCode).toBe(409);
		await app.close();
	});

	test("Keep and roll back need an open trial", async () => {
		const app = server();
		const call = await as(app, "carol");
		expect((await call("POST", "/admin/address/rollback")).statusCode).toBe(409);
		expect(
			(await call("POST", "/admin/address/keep", undefined, "code.example.edu"))
				.statusCode,
		).toBe(409);
		expect(await requests()).toEqual([]);
		await app.close();
	});

	test("a sign-in trial also blocks an address change", async () => {
		await writeStatus({
			id: "6f0d5a4e-2b1c-4e8f-9a7d-3c2b1a0f9e8d",
			kind: "signin",
			state: "trial",
			code: null,
		});
		const app = server();
		const call = await as(app, "carol");
		const res = await call("POST", "/admin/address/apply", NEW);
		expect(res.statusCode).toBe(409);
		expect(res.json()).toMatchObject({ code: "SITE_JOB_BUSY" });
		expect(res.json().message).toContain("trial is open");
		await app.close();
	});

	test("uploaded certificates must cover the new names", async () => {
		await writeView({ ...VIEW, certificateSource: "files" });
		await writeUploadedCertificate([
			"portikus.example.edu",
			"*.preview.portikus.example.edu",
		]);
		const app = server();
		const call = await as(app, "carol");
		const plan = AddressPlan.parse(
			(await call("POST", "/admin/address/plan", NEW)).json(),
		);
		expect(plan.certificate).toEqual({ source: "files", allowed: false });
		const refused = await call("POST", "/admin/address/apply", NEW);
		expect(refused.statusCode).toBe(409);
		expect(refused.json().code).toBe("CERTIFICATE_UPLOAD_REFUSED");
		expect(await requests()).toEqual([]);

		await writeUploadedCertificate(["code.example.edu", "*.preview.code.example.edu"]);
		expect((await call("POST", "/admin/address/apply", NEW)).statusCode).toBe(202);
		await app.close();
	});
});
