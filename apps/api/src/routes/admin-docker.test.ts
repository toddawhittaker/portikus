/**
 * The Docker admin routes (issue #840): administrator only, every change
 * audited without the token, helper requests written atomically with mode
 * 0600, and a usage report that carries counts only (rulings S5, S7, S8).
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
	CookieJar,
	csrfHeaders,
	loginAs,
	type MockOidcProvider,
	startMockOidcProvider,
} from "@portikus/auth/testing";
import {
	DockerAdminResponse,
	DockerUsageResponse,
	OTHER_IMAGES_LABEL,
	RegistryJobRequestFile,
	type RegistryStatusFile,
	SeedJob,
	SeedJobsResponse,
	USAGE_ROWS_MAX,
	USAGE_WINDOW_DAYS,
} from "@portikus/contracts";
import { createTestDb, hasTestDb, type TestDb } from "@portikus/db/testing";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { buildTestServer, PUBLIC_URL } from "../test-support.js";
import { usageReport, usageWindowStart } from "./admin-docker.js";

const skip = !hasTestDb();
const TOKEN = "dckr_pat_SECRET-token-123";

let testDb: TestDb;
let mock: MockOidcProvider;
let app: FastifyInstance;
let jobsDir: string;
let alice: CookieJar;
let carol: CookieJar;

function send(
	jar: CookieJar,
	method: "GET" | "PUT" | "POST" | "DELETE",
	url: string,
	payload?: unknown,
) {
	return app.inject({
		method,
		url,
		headers: csrfHeaders(jar, PUBLIC_URL),
		...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
	});
}

async function requests(): Promise<RegistryJobRequestFile[]> {
	const names = (await readdir(jobsDir)).filter((n) => n.startsWith("request-"));
	return Promise.all(
		names.map(async (n) =>
			RegistryJobRequestFile.parse(
				JSON.parse(await readFile(join(jobsDir, n), "utf8")),
			),
		),
	);
}

async function dockerAudits() {
	return testDb.db
		.selectFrom("audit_events")
		.selectAll()
		.where("action", "like", "docker.%")
		.orderBy("id")
		.execute();
}

function status(over: Partial<RegistryStatusFile> = {}): RegistryStatusFile {
	return {
		sizeBytes: 20 * 1024 ** 3,
		usedBytes: 1024 ** 3,
		hubUp: true,
		ghcrEnabled: false,
		ghcrUp: false,
		hubCredentialSet: true,
		lastClearedAt: null,
		lastClearReason: null,
		updatedAt: "2026-09-30T10:00:00.000Z",
		...over,
	};
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
	await testDb.db
		.insertInto("settings")
		.values({ id: 1, shutdown_grace_seconds: 600 })
		.execute();
	jobsDir = await mkdtemp(join(tmpdir(), "portikus-registry-"));
	app = buildTestServer(testDb.db, mock.issuer, { REGISTRY_JOBS_DIR: jobsDir });
	await app.listen({ port: 0, host: "127.0.0.1" });
	alice = new CookieJar();
	carol = new CookieJar();
	await loginAs(app, "alice", alice);
	await loginAs(app, "carol", carol);
	return async () => {
		await app.close();
		await rm(jobsDir, { recursive: true, force: true });
	};
});

describe.skipIf(skip)("access", () => {
	test("a student is refused every Docker route", async () => {
		for (const [method, url] of [
			["GET", "/admin/docker"],
			["PUT", "/admin/docker/settings"],
			["PUT", "/admin/docker/hub-credential"],
			["DELETE", "/admin/docker/hub-credential"],
			["POST", "/admin/docker/cache/clear"],
			["PUT", "/admin/docker/seed/images"],
			["POST", "/admin/docker/seed/jobs"],
			["POST", "/admin/docker/seed/match"],
			["GET", "/admin/docker/seed/jobs"],
			["GET", "/admin/docker/usage"],
		] as const) {
			const res = await send(alice, method, url, method === "GET" ? undefined : {});
			expect(res.statusCode, `${method} ${url}`).toBe(403);
		}
		expect(await requests()).toEqual([]);
	});
});

describe.skipIf(skip)("GET /admin/docker", () => {
	test("with no status file: no cache, credential not set, defaults", async () => {
		const res = await send(carol, "GET", "/admin/docker");
		expect(res.statusCode).toBe(200);
		const body = DockerAdminResponse.parse(res.json());
		expect(body).toEqual({
			cache: null,
			ghcrEnabled: true,
			seedMaxGiB: 8,
			hubCredential: { isSet: false },
			seedImages: [],
			seed: null,
			imageSizes: {},
			match: null,
		});
	});

	test("reads the helper's status and the seed row; a bad status file is null", async () => {
		await writeFile(join(jobsDir, "status.json"), JSON.stringify(status()));
		await testDb.db
			.insertInto("docker_seed")
			.values({
				images: JSON.stringify(["redis:7"]),
				size_bytes: 3 * 1024 ** 3,
				image_version: "2026.09.15",
				built_at: "2026-09-29T08:00:00.000Z",
			})
			.execute();
		const body = DockerAdminResponse.parse(
			(await send(carol, "GET", "/admin/docker")).json(),
		);
		expect(body.cache).toEqual(status());
		expect(body.hubCredential).toEqual({ isSet: true });
		expect(body.seed).toEqual({
			images: ["redis:7"],
			sizeBytes: 3 * 1024 ** 3,
			imageVersion: "2026.09.15",
			builtAt: "2026-09-29T08:00:00.000Z",
		});

		// The helper's clear error reaches the page (review SEC3).
		const failed = status({ lastClearError: "registry did not stop" });
		await writeFile(join(jobsDir, "status.json"), JSON.stringify(failed));
		const withError = (await send(carol, "GET", "/admin/docker")).json();
		expect(withError.cache.lastClearError).toBe("registry did not stop");

		// The helper writes null when the last clear worked; the status still reads.
		await writeFile(
			join(jobsDir, "status.json"),
			JSON.stringify(status({ lastClearError: null })),
		);
		const cleared = (await send(carol, "GET", "/admin/docker")).json();
		expect(cleared.cache).not.toBeNull();
		expect(cleared.cache.lastClearError).toBeNull();

		await writeFile(join(jobsDir, "status.json"), "{not json");
		const again = (await send(carol, "GET", "/admin/docker")).json();
		expect(again.cache).toBeNull();
		expect(again.hubCredential).toEqual({ isSet: false });
	});
});

describe.skipIf(skip)("sizes and the cache-off line (issue #931)", () => {
	const SIZES = {
		"docker.io/library/python:3.12": {
			bytes: 50_000_000,
			seenAt: "2026-09-30T10:00:00.000Z",
		},
		"docker.io/library/redis:7": {
			bytes: 40_000_000,
			seenAt: "2026-09-30T10:00:00.000Z",
		},
		"ghcr.io/owner/tool:1": { bytes: 7, seenAt: "2026-09-30T10:00:00.000Z" },
	};

	test("the page gets the sizes of its seed and list images only, and never the whole list", async () => {
		await writeFile(
			join(jobsDir, "status.json"),
			JSON.stringify(status({ imageSizes: SIZES, cacheOff: null })),
		);
		await testDb.db
			.updateTable("settings")
			.set({ docker_seed_images: JSON.stringify(["python:3.12", "node:22"]) })
			.where("id", "=", 1)
			.execute();
		const res = await send(carol, "GET", "/admin/docker");
		const body = DockerAdminResponse.parse(res.json());
		expect(body.imageSizes).toEqual({ "docker.io/library/python:3.12": 50_000_000 });
		expect(body.cache).toEqual(status({ cacheOff: null }));
		expect(res.body).not.toContain("redis");
	});

	test("the cache-off reason reaches the page, and Clear cache is refused", async () => {
		const reason = "When setup last ran, the main disk had 9.5 GiB free.";
		await writeFile(
			join(jobsDir, "status.json"),
			JSON.stringify(
				status({ cacheOff: reason, hubUp: false, sizeBytes: 0, usedBytes: 0 }),
			),
		);
		const body = DockerAdminResponse.parse(
			(await send(carol, "GET", "/admin/docker")).json(),
		);
		expect(body.cache?.cacheOff).toBe(reason);
		const res = await send(carol, "POST", "/admin/docker/cache/clear");
		expect(res.statusCode).toBe(404);
		expect(res.json().message).toBe(
			"The pull cache is off, so there is nothing to clear.",
		);
		expect(await requests()).toEqual([]);
		expect(await dockerAudits()).toEqual([]);
	});

	test("usage rows carry their download size, or null", async () => {
		const user = await testDb.db
			.selectFrom("users")
			.select("id")
			.executeTakeFirstOrThrow();
		const ws = await testDb.db
			.insertInto("workspaces")
			.values({ owner_user_id: user.id, label: "ws-s", state: "running" })
			.returning("id")
			.executeTakeFirstOrThrow();
		await testDb.db
			.insertInto("docker_image_presence")
			.values([
				{
					workspace_id: ws.id,
					image: "docker.io/library/redis:7",
					in_seed: false,
					used: true,
				},
				{ workspace_id: ws.id, image: "quay.io/x/y:1", in_seed: false, used: true },
			])
			.execute();
		await writeFile(
			join(jobsDir, "status.json"),
			JSON.stringify(status({ imageSizes: SIZES })),
		);
		const body = DockerUsageResponse.parse(
			(await send(carol, "GET", "/admin/docker/usage")).json(),
		);
		expect(body.notInSeed.map((u) => [u.image, u.downloadBytes])).toEqual([
			["docker.io/library/redis:7", 40_000_000],
			["quay.io/x/y:1", null],
		]);
	});
});

describe.skipIf(skip)("PUT /admin/docker/settings", () => {
	test("refuses extra keys and out-of-range sizes", async () => {
		for (const body of [
			{ ghcrEnabled: true, seedMaxGiB: 0 },
			{ ghcrEnabled: true, seedMaxGiB: 65 },
			{ ghcrEnabled: true, seedMaxGiB: 8, extra: 1 },
			{ ghcrEnabled: "yes", seedMaxGiB: 8 },
			{},
		]) {
			expect(
				(await send(carol, "PUT", "/admin/docker/settings", body)).statusCode,
			).toBe(400);
		}
		expect(await requests()).toEqual([]);
	});

	test("saves, audits, and writes set-ghcr only when the switch changes", async () => {
		const res = await send(carol, "PUT", "/admin/docker/settings", {
			ghcrEnabled: true,
			seedMaxGiB: 12,
		});
		expect(res.statusCode).toBe(204);
		expect(await requests()).toEqual([]);

		await send(carol, "PUT", "/admin/docker/settings", {
			ghcrEnabled: false,
			seedMaxGiB: 12,
		});
		const files = await requests();
		expect(files.map((f) => f.request)).toEqual([{ kind: "set-ghcr", enabled: false }]);

		const body = (await send(carol, "GET", "/admin/docker")).json();
		expect(body.ghcrEnabled).toBe(false);
		expect(body.seedMaxGiB).toBe(12);
		const audits = await dockerAudits();
		expect(audits.map((a) => a.action)).toEqual([
			"docker.settings_changed",
			"docker.settings_changed",
		]);
		expect(audits[1]?.metadata).toMatchObject({
			to: { ghcrEnabled: false, seedMaxGiB: 12 },
		});
	});

	test("the switch goes back when the set-ghcr request cannot be written", async () => {
		await rm(jobsDir, { recursive: true, force: true });
		const res = await send(carol, "PUT", "/admin/docker/settings", {
			ghcrEnabled: false,
			seedMaxGiB: 12,
		});
		expect(res.statusCode).toBe(500);
		const row = await testDb.db
			.selectFrom("settings")
			.select(["docker_ghcr_enabled", "docker_seed_max_gib"])
			.where("id", "=", 1)
			.executeTakeFirstOrThrow();
		expect(row.docker_ghcr_enabled).toBe(true);
		expect(await dockerAudits()).toEqual([]);
	});

	test("a field left out keeps its saved value (review Q3)", async () => {
		await send(carol, "PUT", "/admin/docker/settings", { seedMaxGiB: 20 });
		expect(await requests()).toEqual([]);
		const res = await send(carol, "PUT", "/admin/docker/settings", {
			ghcrEnabled: false,
		});
		expect(res.statusCode).toBe(204);
		expect((await requests()).map((f) => f.request)).toEqual([
			{ kind: "set-ghcr", enabled: false },
		]);
		const body = (await send(carol, "GET", "/admin/docker")).json();
		expect(body).toMatchObject({ ghcrEnabled: false, seedMaxGiB: 20 });
	});
});

describe.skipIf(skip)("the Hub credential (ruling S5)", () => {
	test("PUT writes a 0600 request file atomically, audits only 'set', answers 204", async () => {
		const res = await send(carol, "PUT", "/admin/docker/hub-credential", {
			username: "portikuslab",
			token: TOKEN,
		});
		expect(res.statusCode).toBe(204);
		expect(res.body).toBe("");
		const names = await readdir(jobsDir);
		// No temporary file is left behind.
		expect(names.filter((n) => n.startsWith("."))).toEqual([]);
		const [name] = names;
		expect(name).toMatch(/^request-[0-9a-f-]{36}\.json$/);
		expect((await stat(join(jobsDir, name ?? ""))).mode & 0o777).toBe(0o600);
		const [file] = await requests();
		expect(file?.request).toEqual({
			kind: "set-hub-credential",
			username: "portikuslab",
			token: TOKEN,
		});
		const audits = await dockerAudits();
		expect(audits).toHaveLength(1);
		expect(audits[0]?.metadata).toEqual({ change: "set" });
		expect(JSON.stringify(audits)).not.toContain(TOKEN);
		expect(JSON.stringify(audits)).not.toContain("portikuslab");
	});

	test("a malformed credential is refused without echoing it", async () => {
		const res = await send(carol, "PUT", "/admin/docker/hub-credential", {
			username: "Bad User",
			token: `${TOKEN} with space`,
		});
		expect(res.statusCode).toBe(400);
		expect(res.body).not.toContain(TOKEN);
		expect(await requests()).toEqual([]);
		expect(await dockerAudits()).toEqual([]);
	});

	test("the API never answers with the credential, only isSet", async () => {
		await send(carol, "PUT", "/admin/docker/hub-credential", {
			username: "portikuslab",
			token: TOKEN,
		});
		const res = await send(carol, "GET", "/admin/docker");
		expect(res.body).not.toContain(TOKEN);
		expect(res.body).not.toContain("portikuslab");
		expect(res.json().hubCredential).toEqual({ isSet: false });
	});

	test("DELETE writes remove-hub-credential and audits 'cleared'", async () => {
		const res = await send(carol, "DELETE", "/admin/docker/hub-credential");
		expect(res.statusCode).toBe(204);
		expect((await requests()).map((f) => f.request)).toEqual([
			{ kind: "remove-hub-credential" },
		]);
		expect((await dockerAudits())[0]?.metadata).toEqual({ change: "cleared" });
	});
});

describe.skipIf(skip)("POST /admin/docker/cache/clear", () => {
	test("writes a clear request and answers 202", async () => {
		const res = await send(carol, "POST", "/admin/docker/cache/clear");
		expect(res.statusCode).toBe(202);
		const [file] = await requests();
		expect(file?.request).toEqual({ kind: "clear" });
		const [row] = await dockerAudits();
		expect(row?.action).toBe("docker.cache_clear_requested");
		expect(row?.metadata).toEqual({ requestId: file?.id });
	});
});

describe.skipIf(skip)("the seed list and jobs (ruling S8)", () => {
	test("refuses bad names, duplicates, more than 30, and ghcr.io while ghcr is off", async () => {
		await send(carol, "PUT", "/admin/docker/settings", { ghcrEnabled: false });
		for (const images of [
			["Redis:7"],
			["quay.io/x/y"],
			["localhost:5000/x"],
			["redis:7", "docker.io/library/redis:7"],
			Array.from({ length: 31 }, (_, i) => `img${i}`),
			["ghcr.io/owner/tool:1"],
		]) {
			const res = await send(carol, "PUT", "/admin/docker/seed/images", { images });
			expect(res.statusCode, JSON.stringify(images)).toBe(400);
		}
		expect((await send(carol, "GET", "/admin/docker")).json().seedImages).toEqual([]);
	});

	test("accepts ghcr.io names once ghcr is on, and audits the change", async () => {
		await send(carol, "PUT", "/admin/docker/settings", {
			ghcrEnabled: true,
			seedMaxGiB: 8,
		});
		const images = ["python:3.12", "ghcr.io/owner/tool:1"];
		const res = await send(carol, "PUT", "/admin/docker/seed/images", { images });
		expect(res.statusCode).toBe(204);
		expect((await send(carol, "GET", "/admin/docker")).json().seedImages).toEqual(
			images,
		);
		const last = (await dockerAudits()).at(-1);
		expect(last?.action).toBe("docker.seed_images_changed");
		expect(last?.metadata).toEqual({ from: [], to: images });
	});

	test("a job needs a list, and only one waits or runs at a time", async () => {
		const empty = await send(carol, "POST", "/admin/docker/seed/jobs");
		expect(empty.statusCode).toBe(409);
		expect(empty.json().code).toBe("SEED_LIST_EMPTY");

		await send(carol, "PUT", "/admin/docker/seed/images", { images: ["redis:7"] });
		const first = await send(carol, "POST", "/admin/docker/seed/jobs");
		expect(first.statusCode).toBe(202);
		const job = SeedJob.parse(first.json());
		expect(job).toMatchObject({
			state: "queued",
			images: ["redis:7"],
			finishedAt: null,
		});

		const second = await send(carol, "POST", "/admin/docker/seed/jobs");
		expect(second.statusCode).toBe(409);
		expect(second.json().code).toBe("SEED_JOB_RUNNING");

		await testDb.db
			.updateTable("docker_seed_jobs")
			.set({ state: "succeeded", finished_at: new Date().toISOString() })
			.execute();
		expect((await send(carol, "POST", "/admin/docker/seed/jobs")).statusCode).toBe(202);

		const list = SeedJobsResponse.parse(
			(await send(carol, "GET", "/admin/docker/seed/jobs")).json(),
		);
		expect(list.jobs.map((j) => j.state)).toEqual(["queued", "succeeded"]);
		expect(list.jobs[1]?.id).toBe(job.id);
	});

	test("the job list shows the newest ten", async () => {
		const base = Date.parse("2026-09-01T00:00:00Z");
		for (let i = 0; i < 12; i++) {
			await testDb.db
				.insertInto("docker_seed_jobs")
				.values({
					state: "failed",
					images: JSON.stringify(["redis:7"]),
					requested_at: new Date(base + i * 60_000).toISOString(),
				})
				.execute();
		}
		const list = SeedJobsResponse.parse(
			(await send(carol, "GET", "/admin/docker/seed/jobs")).json(),
		);
		expect(list.jobs).toHaveLength(10);
		expect(list.jobs[0]?.requestedAt).toBe(new Date(base + 11 * 60_000).toISOString());
	});
});

describe.skipIf(skip)("GET /admin/docker/usage (ruling S7)", () => {
	// One workspace per user: alice's and carol's.
	async function workspace(label: string, offset: number): Promise<string> {
		const user = await testDb.db
			.selectFrom("users")
			.select("id")
			.orderBy("id")
			.offset(offset)
			.limit(1)
			.executeTakeFirstOrThrow();
		const row = await testDb.db
			.insertInto("workspaces")
			.values({ owner_user_id: user.id, label, state: "running" })
			.returning("id")
			.executeTakeFirstOrThrow();
		return row.id;
	}

	test("lists images not in the seed and unused seed images, with counts only", async () => {
		const a = await workspace("ws-a", 0);
		const b = await workspace("ws-b", 1);
		const now = new Date();
		const recent = new Date(now.getTime() - 86_400_000).toISOString();
		const old = new Date(now.getTime() - 130 * 86_400_000).toISOString();
		const recentDay = recent.slice(0, 10);
		const oldDay = old.slice(0, 10);
		await testDb.db
			.insertInto("docker_seed")
			.values({
				images: JSON.stringify(["python:3.12", "node:22", "postgres:16"]),
				size_bytes: 1,
				image_version: "2026.09.15",
				built_at: recent,
			})
			.execute();
		await testDb.db
			.insertInto("docker_image_pulls")
			.values([
				{
					image: "docker.io/library/redis:7",
					workspace_id: a,
					day: recentDay,
					pulls: 3,
					last_seen: recent,
				},
				// The same image and workspace on a day outside the window (review F1).
				{
					image: "docker.io/library/redis:7",
					workspace_id: a,
					day: oldDay,
					pulls: 50,
					last_seen: old,
				},
				{
					image: "docker.io/library/redis:7",
					workspace_id: b,
					day: recentDay,
					pulls: 1,
					last_seen: recent,
				},
				{
					image: OTHER_IMAGES_LABEL,
					workspace_id: a,
					day: recentDay,
					pulls: 5,
					last_seen: recent,
				},
				// Outside the window.
				{
					image: "docker.io/library/mysql:8",
					workspace_id: a,
					day: oldDay,
					pulls: 1,
					last_seen: old,
				},
			])
			.execute();
		await testDb.db
			.insertInto("docker_image_presence")
			.values([
				{
					workspace_id: a,
					image: "docker.io/library/python:3.12",
					in_seed: true,
					used: true,
					sampled_at: recent,
				},
				{
					workspace_id: b,
					image: "docker.io/library/node:22",
					in_seed: true,
					used: false,
					sampled_at: recent,
				},
				{
					workspace_id: b,
					image: "quay.io/x/y:1",
					in_seed: false,
					used: true,
					sampled_at: recent,
				},
			])
			.execute();

		const res = await send(carol, "GET", "/admin/docker/usage");
		expect(res.statusCode).toBe(200);
		const body = DockerUsageResponse.parse(res.json());
		expect(body.windowDays).toBe(120);
		expect(body.notInSeed.map((u) => [u.image, u.pulls, u.workspaces])).toEqual([
			["docker.io/library/redis:7", 4, 2],
			[OTHER_IMAGES_LABEL, 5, 1],
			["quay.io/x/y:1", 0, 1],
		]);
		expect(body.notInSeedTotal).toBe(3);
		expect(body.unusedSeed.map((u) => [u.image, u.workspaces])).toEqual([
			["docker.io/library/node:22", 1],
			["docker.io/library/postgres:16", 0],
		]);
		expect(body.unusedSeedTotal).toBe(2);
		expect(res.body).not.toContain(a);
		expect(res.body).not.toContain(b);
	});

	test("the window is 120 calendar days, today included (issue #934)", async () => {
		const ws = await workspace("ws-edge", 0);
		const now = new Date("2026-09-30T15:30:00.000Z");
		const start = usageWindowStart(now);
		expect(start.toISOString()).toBe("2026-06-03T00:00:00.000Z");
		// 2026-06-03 to 2026-09-30 inclusive: 28 + 31 + 31 + 30 days.
		expect(28 + 31 + 31 + 30).toBe(USAGE_WINDOW_DAYS);
		const dayBefore = new Date(start.getTime() - 1);
		await testDb.db
			.insertInto("docker_image_pulls")
			.values([
				{
					image: "docker.io/library/first:1",
					workspace_id: ws,
					day: "2026-06-03",
					pulls: 1,
					last_seen: start.toISOString(),
				},
				{
					image: "docker.io/library/before:1",
					workspace_id: ws,
					day: "2026-06-02",
					pulls: 1,
					last_seen: dayBefore.toISOString(),
				},
			])
			.execute();
		await testDb.db
			.insertInto("docker_image_presence")
			.values([
				{
					workspace_id: ws,
					image: "docker.io/library/seenfirst:1",
					in_seed: false,
					used: true,
					sampled_at: start.toISOString(),
				},
				{
					workspace_id: ws,
					image: "docker.io/library/seenbefore:1",
					in_seed: false,
					used: true,
					sampled_at: dayBefore.toISOString(),
				},
			])
			.execute();
		const body = await usageReport(testDb.db, now);
		expect(body.notInSeed.map((u) => u.image).sort()).toEqual([
			"docker.io/library/first:1",
			"docker.io/library/seenfirst:1",
		]);
	});

	test("with no seed nothing is unused, and the report is empty", async () => {
		expect(await usageReport(testDb.db, new Date())).toEqual({
			windowDays: 120,
			notInSeed: [],
			notInSeedTotal: 0,
			unusedSeed: [],
			unusedSeedTotal: 0,
		});
	});

	test("returns at most USAGE_ROWS_MAX rows with the full count (ruling S7)", async () => {
		const a = await workspace("ws-a", 0);
		const n = USAGE_ROWS_MAX + 5;
		await testDb.db
			.insertInto("docker_image_presence")
			.values(
				Array.from({ length: n }, (_, i) => ({
					workspace_id: a,
					image: `docker.io/library/img${i}:1`,
					in_seed: false,
					used: false,
				})),
			)
			.execute();
		const body = await usageReport(testDb.db, new Date());
		expect(body.notInSeed).toHaveLength(USAGE_ROWS_MAX);
		expect(body.notInSeedTotal).toBe(n);
	});
});

describe.skipIf(skip)("seed images matching the workspace image (issue #932)", () => {
	let imageRoot: string;

	/** Makes `version` the default image, with the given tool versions. */
	async function activeImage(
		version: string,
		node: string,
		python3: string,
		python = "debian",
	) {
		const images = join(imageRoot, "images");
		await mkdir(join(images, version), { recursive: true });
		await writeFile(
			join(images, "aliases.json"),
			JSON.stringify({ default: version, previous: null }),
		);
		await writeFile(
			join(images, version, "manifest.json"),
			JSON.stringify({
				schema: 1,
				version,
				recipeVersion: "2026.09",
				source: "local",
				builtAt: "2026-09-30T10:00:00.000Z",
				fingerprint: null,
				parameters: { node: node.slice(1, 3), python },
				tools: {
					node,
					npm: null,
					python3,
					git: null,
					docker: null,
					claude: null,
					codex: null,
				},
				packages: {},
			}),
		);
	}

	async function seedList(): Promise<string[]> {
		return DockerAdminResponse.parse((await send(carol, "GET", "/admin/docker")).json())
			.seedImages;
	}

	async function jobCount(): Promise<number> {
		return (await testDb.db.selectFrom("docker_seed_jobs").select("id").execute())
			.length;
	}

	beforeEach(async () => {
		imageRoot = await mkdtemp(join(tmpdir(), "portikus-images-"));
		await mkdir(join(imageRoot, "image-jobs"));
		await app.close();
		app = buildTestServer(testDb.db, mock.issuer, {
			REGISTRY_JOBS_DIR: jobsDir,
			IMAGE_JOBS_DIR: join(imageRoot, "image-jobs"),
		});
		await app.listen({ port: 0, host: "127.0.0.1" });
		return async () => {
			await rm(imageRoot, { recursive: true, force: true });
		};
	});

	test("a list no one has set starts with the matching slim images, audited once", async () => {
		await activeImage("2026.09.15", "v24.11.1", "Python 3.13.5");
		const body = DockerAdminResponse.parse(
			(await send(carol, "GET", "/admin/docker")).json(),
		);
		expect(body.seedImages).toEqual(["node:24-slim", "python:3.13-slim"]);
		expect(body.match).toEqual({
			node: { version: "24", image: "node:24-slim" },
			python: { version: "3.13", image: "python:3.13-slim" },
		});
		await send(carol, "GET", "/admin/docker");
		const audits = (await dockerAudits()).filter(
			(a) => a.action === "docker.seed_images_defaulted",
		);
		expect(audits).toHaveLength(1);
		expect(audits[0]).toMatchObject({
			actor: "platform",
			metadata: { to: ["node:24-slim", "python:3.13-slim"] },
		});
	});

	test("a list an administrator emptied stays empty, even after an image change", async () => {
		await send(carol, "PUT", "/admin/docker/seed/images", { images: [] });
		await activeImage("2026.09.15", "v24.11.1", "Python 3.13.5");
		expect(await seedList()).toEqual([]);
		await activeImage(
			"2026.09.16-local.202609301000",
			"v26.0.0",
			"Python 3.13.5",
			"uv-3.14",
		);
		expect(await seedList()).toEqual([]);
		expect(
			(await dockerAudits()).some((a) => a.action === "docker.seed_images_defaulted"),
		).toBe(false);
	});

	test("a new default image never edits the list on its own", async () => {
		await activeImage("2026.09.15", "v24.11.1", "Python 3.13.5");
		expect(await seedList()).toEqual(["node:24-slim", "python:3.13-slim"]);
		await activeImage(
			"2026.09.16-local.202609301000",
			"v26.0.0",
			"Python 3.13.5",
			"uv-3.14",
		);
		expect(await seedList()).toEqual(["node:24-slim", "python:3.13-slim"]);
		expect(await jobCount()).toBe(0);
	});

	test("the match button swaps the old tags for the new and starts a rebuild", async () => {
		await send(carol, "PUT", "/admin/docker/seed/images", {
			images: ["node:24-slim", "redis:7", "python:3.13-slim"],
		});
		await activeImage(
			"2026.09.16-local.202609301000",
			"v26.0.0",
			"Python 3.13.5",
			"uv-3.14",
		);
		const res = await send(carol, "POST", "/admin/docker/seed/match");
		expect(res.statusCode).toBe(202);
		const next = ["redis:7", "node:26-slim", "python:3.14-slim"];
		expect(SeedJob.parse(res.json())).toMatchObject({ state: "queued", images: next });
		expect(await seedList()).toEqual(next);
		const audits = await dockerAudits();
		expect(audits.at(-2)).toMatchObject({
			action: "docker.seed_images_changed",
			metadata: {
				from: ["node:24-slim", "redis:7", "python:3.13-slim"],
				to: next,
				reason: "match-image",
			},
		});
		expect(audits.at(-1)?.action).toBe("docker.seed_job_requested");

		const again = await send(carol, "POST", "/admin/docker/seed/match");
		expect(again.statusCode).toBe(400);
	});

	test("the button adds nothing that would pass the size limit", async () => {
		await send(carol, "PUT", "/admin/docker/settings", { seedMaxGiB: 1 });
		await send(carol, "PUT", "/admin/docker/seed/images", { images: ["redis:7"] });
		await writeFile(
			join(jobsDir, "status.json"),
			JSON.stringify(
				status({
					imageSizes: {
						"docker.io/library/redis:7": {
							bytes: 1024 ** 3,
							seenAt: "2026-09-30T10:00:00.000Z",
						},
					},
				}),
			),
		);
		await activeImage("2026.09.15", "v24.11.1", "Python 3.13.5");
		const res = await send(carol, "POST", "/admin/docker/seed/match");
		expect(res.statusCode).toBe(400);
		expect(res.json().message).toContain("size limit");
		expect(await seedList()).toEqual(["redis:7"]);
		expect(await jobCount()).toBe(0);
	});

	test("while a rebuild runs the button changes nothing", async () => {
		await send(carol, "PUT", "/admin/docker/seed/images", { images: ["node:24-slim"] });
		await testDb.db
			.insertInto("docker_seed_jobs")
			.values({ images: JSON.stringify(["node:24-slim"]) })
			.execute();
		await activeImage("2026.09.16-local.202609301000", "v26.0.0", "Python 3.13.5");
		const res = await send(carol, "POST", "/admin/docker/seed/match");
		expect(res.statusCode).toBe(409);
		expect(await seedList()).toEqual(["node:24-slim"]);
	});

	test("with no readable image manifest there is no match and the button is 404", async () => {
		const body = DockerAdminResponse.parse(
			(await send(carol, "GET", "/admin/docker")).json(),
		);
		expect(body.match).toBe(null);
		expect(body.seedImages).toEqual([]);
		expect((await send(carol, "POST", "/admin/docker/seed/match")).statusCode).toBe(
			404,
		);
	});
});
