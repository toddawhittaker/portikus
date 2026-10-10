/**
 * The LMS platform routes (SPEC.md sections 5.1, 20.1 and 24.11, ADR 0025
 * and 0059): administrator-only, values checked against the shared fixture
 * the root job also uses, the operator's platforms protected, one request
 * file in, the audit row on request.
 */
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CookieJar,
	csrfHeaders,
	loginAs,
	type MockOidcProvider,
	startMockOidcProvider,
} from "@portikus/auth/testing";
import {
	AdminLmsPlatforms,
	type AdminLtiPlatform,
	MAX_ADMIN_LTI_PLATFORMS,
	SiteJobRequest,
} from "@portikus/contracts";
import { createTestDb, hasTestDb, type TestDb } from "@portikus/db/testing";
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
import { buildTestServer, PUBLIC_URL } from "../testing/test-support.js";

const skip = !hasTestDb();
let testDb: TestDb;
let mock: MockOidcProvider;
let dir = "";
let jobsDir = "";
let pageFile = "";
let operatorFile = "";

const fixture = JSON.parse(
	await readFile(
		new URL("../../../../packaging/site/tests/fixtures/values.json", import.meta.url),
		"utf8",
	),
) as { fields: Record<string, { good: unknown[]; bad: unknown[] }> };
const field = (name: string) =>
	fixture.fields[name] as { good: string[]; bad: string[] };

const canvas: AdminLtiPlatform = {
	name: "Canvas",
	issuer: "https://canvas.example.edu",
	clientId: "10000000000001",
	authLoginUrl: "https://canvas.example.edu/api/lti/authorize_redirect",
	keysetUrl: "https://canvas.example.edu/api/lti/security/jwks",
	authTokenUrl: "https://canvas.example.edu/login/oauth2/token",
	deploymentIds: ["1:abc"],
	mock: false,
};

const operatorPlatform = {
	name: "mock-lms",
	issuer: "http://127.0.0.1:9000",
	clientId: "portikus-mock",
	authLoginUrl: "http://127.0.0.1:9000/authorize",
	keysetUrl: "http://127.0.0.1:9000/jwks",
	deploymentIds: ["d1"],
	mock: true,
};

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
	dir = await mkdtemp(join(tmpdir(), "admin-lms-"));
	jobsDir = join(dir, "site-jobs");
	pageFile = join(dir, "lti-platforms-admin.json");
	operatorFile = join(dir, "lti-platforms.json");
	await mkdir(jobsDir);
	await writeFile(
		operatorFile,
		JSON.stringify({ version: 1, platforms: [operatorPlatform] }),
	);
});

afterEach(async () => {
	if (dir) await rm(dir, { recursive: true, force: true });
});

function server(): FastifyInstance {
	return buildTestServer(testDb.db, mock.issuer, {
		SITE_JOBS_DIR: jobsDir,
		LTI_ADMIN_PLATFORMS_FILE: pageFile,
		LTI_PLATFORMS_FILE: operatorFile,
	});
}

async function as(app: FastifyInstance, who: string) {
	const jar = new CookieJar();
	await loginAs(app, who, jar);
	return (method: "GET" | "PUT", url: string, payload?: unknown) =>
		app.inject({
			method,
			url,
			headers: csrfHeaders(jar, PUBLIC_URL),
			...(payload === undefined ? {} : { payload: payload as object }),
		});
}

async function requests(): Promise<string[]> {
	return (await readdir(jobsDir)).filter((n) => n.startsWith("request-"));
}

async function clearRequests(): Promise<void> {
	for (const name of await requests()) await rm(join(jobsDir, name));
}

/** Run `check` against a fresh app. */
async function withApp(check: (call: Awaited<ReturnType<typeof as>>) => Promise<void>) {
	const app = server();
	await app.ready();
	try {
		await check(await as(app, "carol"));
	} finally {
		await app.close();
	}
}

describe.skipIf(skip)("admin LMS routes (ADR 0059)", () => {
	test("only an administrator may use them", async () => {
		const app = server();
		await app.ready();
		try {
			const origin = { origin: new URL(PUBLIC_URL).origin };
			for (const method of ["GET", "PUT"] as const) {
				const url = "/admin/lms";
				expect((await app.inject({ method, url, headers: origin })).statusCode).toBe(
					401,
				);
				expect((await (await as(app, "alice"))(method, url, {})).statusCode).toBe(403);
			}
		} finally {
			await app.close();
		}
	});

	test("the view shows the tool's addresses, the operator's platforms and the page's", async () => {
		await writeFile(pageFile, JSON.stringify({ version: 1, platforms: [canvas] }));
		await withApp(async (call) => {
			const view = AdminLmsPlatforms.parse((await call("GET", "/admin/lms")).json());
			expect(view.toolUrls).toEqual({
				loginUrl: `${PUBLIC_URL}/lti/login`,
				launchUrl: `${PUBLIC_URL}/lti/launch`,
				keysetUrl: `${PUBLIC_URL}/lti/jwks`,
				deepLinkingUrl: `${PUBLIC_URL}/lti/launch`,
			});
			expect(view.operatorPlatforms).toEqual([operatorPlatform]);
			expect(view.platforms).toEqual([canvas]);
			expect(view.job).toBeNull();
		});
	});

	test("a save writes one owner-only request and one audit row without secrets", async () => {
		await withApp(async (call) => {
			const res = await call("PUT", "/admin/lms", { platforms: [canvas] });
			expect(res.statusCode).toBe(202);
			const [name] = await requests();
			const request = SiteJobRequest.parse(
				JSON.parse(await readFile(join(jobsDir, name ?? ""), "utf8")),
			);
			expect(request).toMatchObject({ kind: "lti-platforms", platforms: [canvas] });
			const rows = await testDb.db
				.selectFrom("audit_events")
				.selectAll()
				.where("action", "=", "site.job_requested")
				.execute();
			expect(rows).toHaveLength(1);
			expect(rows[0]?.metadata).toEqual({
				kind: "lti-platforms",
				platforms: [
					{ name: "Canvas", issuer: canvas.issuer, clientId: canvas.clientId },
				],
			});
		});
	});

	test("a mock platform and an http address are refused", async () => {
		await withApp(async (call) => {
			for (const bad of [
				{ ...canvas, mock: true },
				{ ...canvas, issuer: "http://canvas.example.edu" },
				{ ...canvas, authLoginUrl: "http://canvas.example.edu/login" },
				{ ...canvas, keysetUrl: "http://canvas.example.edu/jwks" },
			]) {
				expect((await call("PUT", "/admin/lms", { platforms: [bad] })).statusCode).toBe(
					400,
				);
			}
			expect(await requests()).toEqual([]);
		});
	});

	test("a pair or name the operator's file holds is refused", async () => {
		await withApp(async (call) => {
			// A mock may use https too; its pair is what the page platform repeats.
			await writeFile(
				operatorFile,
				JSON.stringify({
					version: 1,
					platforms: [
						{ ...operatorPlatform, issuer: canvas.issuer, clientId: canvas.clientId },
					],
				}),
			);
			const samePair = { ...canvas, name: "Other" };
			const sameName = { ...canvas, clientId: "another", name: operatorPlatform.name };
			expect(
				(await call("PUT", "/admin/lms", { platforms: [samePair] })).statusCode,
			).toBe(400);
			expect(
				(await call("PUT", "/admin/lms", { platforms: [sameName] })).statusCode,
			).toBe(400);
			expect(await requests()).toEqual([]);
		});
	});

	test("repeated names, repeated pairs and more than the limit are refused", async () => {
		await withApp(async (call) => {
			expect(
				(await call("PUT", "/admin/lms", { platforms: [canvas, canvas] })).statusCode,
			).toBe(400);
			expect(
				(
					await call("PUT", "/admin/lms", {
						platforms: [canvas, { ...canvas, name: "Canvas two" }],
					})
				).statusCode,
			).toBe(400);
			const many = Array.from({ length: MAX_ADMIN_LTI_PLATFORMS + 1 }, (_, i) => ({
				...canvas,
				name: `LMS ${i}`,
				clientId: `client${i}`,
			}));
			expect((await call("PUT", "/admin/lms", { platforms: many })).statusCode).toBe(
				400,
			);
			const limit = many.slice(0, MAX_ADMIN_LTI_PLATFORMS);
			expect((await call("PUT", "/admin/lms", { platforms: limit })).statusCode).toBe(
				202,
			);
		});
	});

	test("every fixture value is judged as the root job judges it", async () => {
		await withApp(async (call) => {
			const cases: [string, (value: string) => AdminLtiPlatform][] = [
				["httpsUrl", (v) => ({ ...canvas, issuer: v, authLoginUrl: v })],
				["keysetUrl", (v) => ({ ...canvas, keysetUrl: v, authTokenUrl: v })],
				["identifier", (v) => ({ ...canvas, clientId: v, deploymentIds: [v] })],
				["platformName", (v) => ({ ...canvas, name: v })],
			];
			for (const [name, build] of cases) {
				for (const bad of field(name).bad) {
					const res = await call("PUT", "/admin/lms", { platforms: [build(bad)] });
					expect(res.statusCode, `${name} ${JSON.stringify(bad)}`).toBe(400);
				}
				for (const good of field(name).good) {
					const res = await call("PUT", "/admin/lms", { platforms: [build(good)] });
					expect(res.statusCode, `${name} ${good}`).toBe(202);
					await clearRequests();
				}
			}
		});
	});

	test("a second save while one waits is refused", async () => {
		await withApp(async (call) => {
			expect((await call("PUT", "/admin/lms", { platforms: [] })).statusCode).toBe(202);
			const second = await call("PUT", "/admin/lms", { platforms: [canvas] });
			expect(second.statusCode).toBe(409);
			expect(second.json().code).toBe("SITE_JOB_BUSY");
		});
	});
});
