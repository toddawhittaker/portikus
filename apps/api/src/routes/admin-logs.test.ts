import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	CookieJar,
	loginAs,
	type MockOidcProvider,
	startMockOidcProvider,
} from "@portikus/auth/testing";
import { LogCounts, LogPage } from "@portikus/contracts";
import { createTestDb, hasTestDb, type TestDb } from "@portikus/db/testing";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { buildTestServer, PUBLIC_URL } from "../test-support.js";

const skip = !hasTestDb();
// The e2e fake reads FAKE_JOURNAL_FILE as the API's journal.
const FAKE = fileURLToPath(
	new URL("../../../../e2e/fake-journalctl.mjs", import.meta.url),
);
const journalFile = join(mkdtempSync(join(tmpdir(), "portikus-logs-")), "journal.log");
process.env.FAKE_JOURNAL_FILE = journalFile;

let testDb: TestDb;
let mock: MockOidcProvider;
let app: FastifyInstance;
let carol: CookieJar;

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
	writeFileSync(journalFile, "");
	app = buildTestServer(testDb.db, mock.issuer, { JOURNALCTL_PATH: FAKE });
	await app.ready();
	carol = new CookieJar();
	await loginAs(app, "carol", carol);
	return async () => {
		await app.close();
	};
});

function journal(lines: Record<string, unknown>[]): void {
	const at = Date.now() - 60_000;
	writeFileSync(
		journalFile,
		lines
			.map((fields, i) =>
				typeof fields.raw === "string"
					? fields.raw
					: JSON.stringify({
							level: "warn",
							service: "api",
							time: new Date(at + i * 1000).toISOString(),
							...fields,
						}),
			)
			.map((line) => `${line}\n`)
			.join(""),
	);
}

function get(url: string, jar: CookieJar | null = carol) {
	return app.inject({
		method: "GET",
		url,
		headers: jar ? { cookie: jar.cookieHeader() } : {},
	});
}

test.skipIf(skip)(
	"only an administrator may read the logs or their counts",
	async () => {
		const alice = new CookieJar();
		await loginAs(app, "alice", alice);
		for (const url of ["/admin/logs", "/admin/logs/counts?range=1h"]) {
			expect((await get(url, null)).statusCode, url).toBe(401);
			expect((await get(url, alice)).statusCode, url).toBe(403);
			expect((await get(url)).statusCode, url).toBe(200);
		}
	},
);

test.skipIf(skip)(
	"lines come newest first, redacted, with the user's name",
	async () => {
		const carolId = (
			await testDb.db
				.selectFrom("users")
				.select("id")
				.where("oidc_subject", "=", "carol")
				.executeTakeFirstOrThrow()
		).id;
		journal([
			{ msg: "older", code: "TERMINAL_LIMIT", userId: carolId, token: "secret-token" },
			{ raw: "Started Portikus API." },
			{ level: "debug", msg: "debug" },
			{ level: "error", msg: "newer", req: { headers: { cookie: "sid=abc" } } },
		]);
		const defaults = LogPage.parse((await get("/admin/logs")).json());
		// Error and warn by default; journalctl's --grep drops the rest.
		expect(defaults.lines.map((line) => line.line.msg)).toEqual(["newer", "older"]);
		const res = await get("/admin/logs?level=error,warn,info,debug");
		expect(res.statusCode).toBe(200);
		expect(res.headers["cache-control"]).toBe("no-store");
		const page = LogPage.parse(res.json());
		expect(page.lines.map((line) => line.line.msg)).toEqual([
			"newer",
			"debug",
			"older",
		]);
		expect(page.lines[2]?.userName).toBe("Carol Admin");
		expect(page.skippedLines).toBe(1);
		expect(page.nextCursor).toBeNull();
		expect(res.body).not.toContain("secret-token");
		expect(res.body).not.toContain("sid=abc");
	},
);

test.skipIf(skip)("filters by text and user, and pages by cursor", async () => {
	journal(Array.from({ length: 120 }, (_, i) => ({ msg: `line ${i}` })));
	const first = LogPage.parse((await get("/admin/logs")).json());
	expect(first.lines).toHaveLength(100);
	expect(first.lines[0]?.line.msg).toBe("line 119");
	const next = LogPage.parse(
		(
			await get(`/admin/logs?cursor=${encodeURIComponent(first.nextCursor ?? "")}`)
		).json(),
	);
	expect(next.lines.map((line) => line.line.msg)).toEqual(
		Array.from({ length: 20 }, (_, i) => `line ${19 - i}`),
	);
	const text = LogPage.parse((await get("/admin/logs?q=LINE%2011")).json());
	expect(text.lines.map((line) => line.line.msg)).toEqual([
		"line 119",
		"line 118",
		"line 117",
		"line 116",
		"line 115",
		"line 114",
		"line 113",
		"line 112",
		"line 111",
		"line 110",
		"line 11",
	]);
});

test.skipIf(skip)(
	"a malformed cursor or unknown field is refused with 400",
	async () => {
		for (const query of [
			"?cursor=abc",
			"?cursor=--unit%3Dsshd.service",
			"?unit=sshd.service",
		]) {
			const res = await get(`/admin/logs${query}`);
			expect(res.statusCode, query).toBe(400);
			expect(res.json().code).toBe("VALIDATION_FAILED");
		}
		expect((await get("/admin/logs/counts?range=2h")).statusCode).toBe(400);
	},
);

test.skipIf(skip)("a missing journalctl is 503 LOGS_UNAVAILABLE", async () => {
	const other = buildTestServer(testDb.db, mock.issuer);
	await other.ready();
	const jar = new CookieJar();
	await loginAs(other, "carol", jar);
	for (const url of ["/admin/logs", "/admin/logs/counts?range=1h"]) {
		const res = await other.inject({
			method: "GET",
			url,
			headers: { cookie: jar.cookieHeader() },
		});
		expect(res.statusCode, url).toBe(503);
		expect(res.json().code).toBe("LOGS_UNAVAILABLE");
	}
	await other.close();
});

test.skipIf(skip)("counts error and warn lines per bucket", async () => {
	journal([
		{ level: "error" },
		{ level: "fatal" },
		{ level: "warn" },
		{ level: "info" },
	]);
	const counts = LogCounts.parse((await get("/admin/logs/counts?range=7d")).json());
	expect(counts.bucketSeconds).toBe(3600);
	expect(counts.complete).toBe(true);
	const total = counts.buckets.reduce(
		(sum, bucket) => ({ e: sum.e + bucket.errors, w: sum.w + bucket.warnings }),
		{ e: 0, w: 0 },
	);
	expect(total).toEqual({ e: 2, w: 1 });
	expect(counts.oldestAt).not.toBeNull();
});
