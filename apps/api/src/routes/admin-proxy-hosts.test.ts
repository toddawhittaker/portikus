/**
 * The proxy host routes (SPEC.md sections 20.1 and 24.11, ADR 0059):
 * administrator-only, values checked against the shared fixture the root
 * job also uses, one request file in, the audit row on request.
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
	AdminProxyHosts,
	MAX_PROXY_HOSTS,
	SiteJobRequest,
	SiteJobView,
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
let hostsFile = "";
let squidConf = "";

const fixture = JSON.parse(
	await readFile(
		new URL("../../../../packaging/site/tests/fixtures/values.json", import.meta.url),
		"utf8",
	),
) as { fields: Record<string, { good: string[]; bad: string[] }> };
const proxyHost = fixture.fields.proxyHost as { good: string[]; bad: string[] };

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
	dir = await mkdtemp(join(tmpdir(), "admin-proxy-hosts-"));
	jobsDir = join(dir, "site-jobs");
	hostsFile = join(dir, "proxy-hosts.json");
	squidConf = join(dir, "squid.conf");
	await mkdir(jobsDir);
});

afterEach(async () => {
	if (dir) await rm(dir, { recursive: true, force: true });
});

function server(overrides: Record<string, unknown> = {}): FastifyInstance {
	return buildTestServer(testDb.db, mock.issuer, {
		SITE_JOBS_DIR: jobsDir,
		PROXY_HOSTS_FILE: hostsFile,
		SQUID_CONF_FILE: squidConf,
		...overrides,
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

describe.skipIf(skip)("admin proxy host routes (ADR 0059)", () => {
	test("only an administrator may use them", async () => {
		const app = server();
		await app.ready();
		try {
			const origin = { origin: new URL(PUBLIC_URL).origin };
			for (const method of ["GET", "PUT"] as const) {
				const url = "/admin/proxy-hosts";
				expect((await app.inject({ method, url, headers: origin })).statusCode).toBe(
					401,
				);
				expect((await (await as(app, "alice"))(method, url, {})).statusCode).toBe(403);
			}
		} finally {
			await app.close();
		}
	});

	test("with no job directory the routes are 404", async () => {
		const app = server({ SITE_JOBS_DIR: undefined });
		await app.ready();
		try {
			const call = await as(app, "carol");
			expect((await call("GET", "/admin/proxy-hosts")).statusCode).toBe(404);
			expect((await call("PUT", "/admin/proxy-hosts", { hosts: [] })).statusCode).toBe(
				404,
			);
		} finally {
			await app.close();
		}
	});

	test("the view lists the page's hosts and the operator's, read-only", async () => {
		await writeFile(
			hostsFile,
			JSON.stringify({ version: 1, hosts: ["api.example.com"] }),
		);
		await writeFile(
			squidConf,
			"acl portikus_hosts_443 dstdomain -n github.com api.openai.com\nacl portikus_hosts_80 dstdomain -n plain.example.edu\n",
		);
		const app = server();
		await app.ready();
		try {
			const res = await (await as(app, "carol"))("GET", "/admin/proxy-hosts");
			expect(res.statusCode).toBe(200);
			expect(AdminProxyHosts.parse(res.json())).toEqual({
				operatorHosts: ["api.openai.com", "github.com", "plain.example.edu:80"],
				hosts: ["api.example.com"],
				job: null,
			});
		} finally {
			await app.close();
		}
	});

	test("a wrong page file reads as empty so the page can still save over it", async () => {
		await writeFile(hostsFile, "not json");
		const app = server();
		await app.ready();
		try {
			const res = await (await as(app, "carol"))("GET", "/admin/proxy-hosts");
			expect(AdminProxyHosts.parse(res.json()).hosts).toEqual([]);
		} finally {
			await app.close();
		}
	});

	test("every fixture value is judged as the root job judges it", async () => {
		const app = server();
		await app.ready();
		try {
			const call = await as(app, "carol");
			for (const bad of proxyHost.bad) {
				const res = await call("PUT", "/admin/proxy-hosts", { hosts: [bad] });
				expect(res.statusCode, JSON.stringify(bad)).toBe(400);
			}
			expect(await requests()).toEqual([]);
			for (const good of proxyHost.good) {
				const res = await call("PUT", "/admin/proxy-hosts", { hosts: [good] });
				expect(res.statusCode, good).toBe(202);
				// Waiting job: clear it so the next value is not refused as busy.
				for (const name of await requests()) await rm(join(jobsDir, name));
			}
		} finally {
			await app.close();
		}
	});

	test("a repeated host and more than the limit are refused", async () => {
		const app = server();
		await app.ready();
		try {
			const call = await as(app, "carol");
			expect(
				(
					await call("PUT", "/admin/proxy-hosts", {
						hosts: ["a.example.com", "a.example.com"],
					})
				).statusCode,
			).toBe(400);
			const many = Array.from(
				{ length: MAX_PROXY_HOSTS + 1 },
				(_, i) => `h${i}.example.com`,
			);
			expect(
				(await call("PUT", "/admin/proxy-hosts", { hosts: many })).statusCode,
			).toBe(400);
			const limit = many.slice(0, MAX_PROXY_HOSTS);
			expect(
				(await call("PUT", "/admin/proxy-hosts", { hosts: limit })).statusCode,
			).toBe(202);
			expect(await requests()).toHaveLength(1);
		} finally {
			await app.close();
		}
	});

	test("a save writes one owner-only request, lowercased, and one audit row", async () => {
		const app = server();
		await app.ready();
		try {
			const res = await (await as(app, "carol"))("PUT", "/admin/proxy-hosts", {
				hosts: ["API.Example.com"],
			});
			expect(res.statusCode).toBe(202);
			const job = SiteJobView.parse(res.json());
			expect(job.state).toBe("queued");
			const [name] = await requests();
			expect(name).toBe(`request-${job.id}.json`);
			const request = SiteJobRequest.parse(
				JSON.parse(await readFile(join(jobsDir, name ?? ""), "utf8")),
			);
			expect(request).toMatchObject({
				kind: "proxy-hosts",
				hosts: ["api.example.com"],
			});
			const rows = await testDb.db
				.selectFrom("audit_events")
				.selectAll()
				.where("action", "=", "site.job_requested")
				.execute();
			expect(rows).toHaveLength(1);
			expect(rows[0]).toMatchObject({ target: job.id, result: "ok" });
			expect(rows[0]?.actor).toMatch(/^user:/);
			expect(rows[0]?.metadata).toMatchObject({
				kind: "proxy-hosts",
				hosts: ["api.example.com"],
			});
		} finally {
			await app.close();
		}
	});

	test("a second save while one waits is refused", async () => {
		const app = server();
		await app.ready();
		try {
			const call = await as(app, "carol");
			expect((await call("PUT", "/admin/proxy-hosts", { hosts: [] })).statusCode).toBe(
				202,
			);
			const second = await call("PUT", "/admin/proxy-hosts", {
				hosts: ["a.example.com"],
			});
			expect(second.statusCode).toBe(409);
			expect(second.json().code).toBe("SITE_JOB_BUSY");
			expect(await requests()).toHaveLength(1);
		} finally {
			await app.close();
		}
	});
});
