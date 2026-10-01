/**
 * The Workspace image routes (docs/SPEC.md section 22.4; ADR 0030).
 * Administrator-only and CSRF-checked; the API writes nothing but one
 * request file, and refuses a second request while one waits or runs.
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
import type {
	ImageHealth,
	ImageJobStatusFile,
	ImageManifest,
} from "@portikus/contracts";
import { createTestDb, hasTestDb, type TestDb } from "@portikus/db/testing";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { tailLines } from "../job-files.js";
import { buildTestServer, PUBLIC_URL } from "../test-support.js";

// A pass-through spy, so a test can see the order the route reads files in.
vi.mock("node:fs/promises", async (importOriginal) => {
	const fs = await importOriginal<typeof import("node:fs/promises")>();
	return { ...fs, readFile: vi.fn(fs.readFile) };
});

const skip = !hasTestDb();

const OLD = "2026.09.9";
const CURRENT = "2026.09.10";
const BUILT = "2026.09.10-local.202609281530";
const BROKEN = "2026.09.10-local.202609281600";
const FP_CURRENT = "a".repeat(64);
const FP_OLD = "b".repeat(64);

let testDb: TestDb;
let mock: MockOidcProvider;
let app: FastifyInstance;
let root: string;
let jobsDir: string;
let imagesDir: string;
let alice: CookieJar;
let carol: CookieJar;

function manifest(version: string, over: Partial<ImageManifest> = {}): ImageManifest {
	return {
		schema: 1,
		version,
		recipeVersion: "2026.09.10",
		source: version.includes("-local.") ? "local" : "published",
		builtAt: "2026-09-20T10:00:00Z",
		fingerprint: null,
		parameters: { node: "24", python: "debian" },
		tools: {
			node: "v24.8.0",
			npm: "11.6.0",
			python3: "Python 3.13.5",
			git: "git version 2.47.3",
			docker: "Docker version 28.4.0",
			claude: "2.0.1",
			codex: "0.40.0",
		},
		packages: { curl: "8.14.1-2", git: "1:2.47.3-0" },
		...over,
	};
}

function health(result: "passed" | "failed"): ImageHealth {
	return {
		result,
		checkedAt: "2026-09-28T10:00:00Z",
		checks: [{ name: "node --version", ok: result === "passed", output: "v24.8.0" }],
	};
}

async function putImage(
	version: string,
	m: ImageManifest | null,
	h: ImageHealth | null,
) {
	await mkdir(join(imagesDir, version), { recursive: true });
	if (m) await writeFile(join(imagesDir, version, "manifest.json"), JSON.stringify(m));
	if (h) await writeFile(join(imagesDir, version, "health.json"), JSON.stringify(h));
}

async function putJob(status: ImageJobStatusFile, log = "") {
	await mkdir(join(jobsDir, status.id), { recursive: true });
	await writeFile(join(jobsDir, status.id, "status.json"), JSON.stringify(status));
	await writeFile(join(jobsDir, status.id, "log.txt"), log);
}

function jobStatus(over: Partial<ImageJobStatusFile> = {}): ImageJobStatusFile {
	return {
		id: "11111111-1111-4111-8111-111111111111",
		kind: "fetch",
		state: "running",
		step: "Downloading",
		version: CURRENT,
		message: null,
		startedAt: "2026-09-28T10:00:00Z",
		finishedAt: null,
		...over,
	};
}

function send(jar: CookieJar, method: "GET" | "POST", url: string, payload?: unknown) {
	return app.inject({
		method,
		url,
		headers: csrfHeaders(jar, PUBLIC_URL),
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
	root = await mkdtemp(join(tmpdir(), "portikus-image-"));
	jobsDir = join(root, "image-jobs");
	imagesDir = join(root, "images");
	await mkdir(jobsDir);
	await mkdir(imagesDir);
	await writeFile(
		join(imagesDir, "aliases.json"),
		JSON.stringify({ default: CURRENT, previous: OLD }),
	);
	await putImage(OLD, manifest(OLD, { fingerprint: FP_OLD }), health("passed"));
	await putImage(
		CURRENT,
		manifest(CURRENT, { fingerprint: FP_CURRENT }),
		health("passed"),
	);
	await putImage(
		BUILT,
		manifest(BUILT, {
			parameters: { node: "26", python: "uv-3.14" },
			tools: { ...manifest(BUILT).tools, node: "v26.0.0" },
			packages: { curl: "8.14.1-3", zsh: "5.9-8" },
		}),
		health("passed"),
	);
	await putImage(BROKEN, manifest(BROKEN), health("failed"));
	app = buildTestServer(testDb.db, mock.issuer, { IMAGE_JOBS_DIR: jobsDir });
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

describe.skipIf(skip)("GET /admin/image", () => {
	test("lists default, previous and candidates with health and workspace counts", async () => {
		const ws = (await send(alice, "POST", "/workspaces")).json().id as string;
		await testDb.db
			.updateTable("workspaces")
			.set({ image_version: FP_CURRENT })
			.where("id", "=", ws)
			.execute();
		const res = await send(carol, "GET", "/admin/image");
		expect(res.statusCode).toBe(200);
		const body = res.json();
		expect(body.default).toBe(CURRENT);
		expect(body.previous).toBe(OLD);
		expect(
			body.images.map((i: { version: string; role: string }) => [i.version, i.role]),
		).toEqual([
			[CURRENT, "default"],
			[OLD, "previous"],
			[BROKEN, "candidate"],
			[BUILT, "candidate"],
		]);
		expect(body.images[0].workspaces).toBe(1);
		expect(body.images[0].manifest.packageCount).toBe(2);
		expect(body.images[0].manifest.packages).toBeUndefined();
		expect(body.images[2].health.result).toBe("failed");
		expect(body.otherWorkspaces).toBe(0);
		expect(body.job).toBeNull();
	});

	test("shows each image's recorded size and the disk's free space", async () => {
		await writeFile(
			join(imagesDir, CURRENT, "size.json"),
			JSON.stringify({ bytes: 880803840 }),
		);
		await writeFile(join(imagesDir, OLD, "size.json"), "not json");
		const body = (await send(carol, "GET", "/admin/image")).json();
		const size = (v: string) =>
			body.images.find((i: { version: string }) => i.version === v).sizeBytes;
		expect(size(CURRENT)).toBe(880803840);
		expect(size(OLD)).toBeNull();
		expect(size(BUILT)).toBeNull();
		expect(body.disk.totalBytes).toBeGreaterThan(0);
		expect(body.disk.freeBytes).toBeGreaterThan(0);
		expect(body.disk.freeBytes).toBeLessThanOrEqual(body.disk.totalBytes);
	});

	test("is administrator-only", async () => {
		expect((await send(alice, "GET", "/admin/image")).statusCode).toBe(403);
		expect((await app.inject({ method: "GET", url: "/admin/image" })).statusCode).toBe(
			401,
		);
	});

	test("answers 404 when IMAGE_JOBS_DIR is unset", async () => {
		const offApp = buildTestServer(testDb.db, mock.issuer);
		await offApp.ready();
		const jar = new CookieJar();
		await loginAs(offApp, "carol", jar);
		const res = await offApp.inject({
			method: "GET",
			url: "/admin/image",
			headers: csrfHeaders(jar, PUBLIC_URL),
		});
		expect(res.statusCode).toBe(404);
		await offApp.close();
	});

	test("writes image.job_finished once when it first sees a finished job", async () => {
		await putJob(
			jobStatus({
				state: "succeeded",
				step: "Done",
				finishedAt: "2026-09-28T10:20:00Z",
			}),
		);
		await send(carol, "GET", "/admin/image");
		await send(carol, "GET", "/admin/image");
		const finished = await audits("image.job_finished");
		expect(finished).toHaveLength(1);
		expect(finished[0]?.metadata).toEqual({
			kind: "fetch",
			result: "succeeded",
			version: CURRENT,
		});
	});
});

describe.skipIf(skip)("GET /admin/image, a newer published image (issue #861)", () => {
	async function putPublished(image: string | null) {
		await writeFile(
			join(imagesDir, "published.json"),
			JSON.stringify({ checkedAt: "2026-09-29T04:00:00.000Z", image, package: null }),
		);
	}

	async function adminNotifications() {
		return testDb.db
			.selectFrom("notifications")
			.innerJoin("users", "users.id", "notifications.user_id")
			.select(["users.role", "notifications.title", "notifications.tone"])
			.execute();
	}

	test("names a published image newer than every image on the server, and writes nothing", async () => {
		await putPublished("2026.09.13");
		const res = await send(carol, "GET", "/admin/image");
		expect(res.json().newerPublished).toBe("2026.09.13");
		// A read-only page load leaves notices to the hourly timer.
		expect(await adminNotifications()).toEqual([]);
		expect(await audits("image.release_noticed")).toHaveLength(0);
	});

	test("says nothing once that version is on the server", async () => {
		await putPublished("2026.09.13");
		await putImage("2026.09.13", manifest("2026.09.13"), null);
		const res = await send(carol, "GET", "/admin/image");
		expect(res.json().newerPublished).toBeNull();
		expect(await adminNotifications()).toEqual([]);
	});

	test("says nothing when the published image is older, or the check never ran", async () => {
		expect((await send(carol, "GET", "/admin/image")).json().newerPublished).toBeNull();
		await putPublished(CURRENT);
		expect((await send(carol, "GET", "/admin/image")).json().newerPublished).toBeNull();
		await writeFile(join(imagesDir, "published.json"), "not json");
		expect((await send(carol, "GET", "/admin/image")).json().newerPublished).toBeNull();
		expect(await adminNotifications()).toEqual([]);
	});
});

describe.skipIf(skip)("GET /admin/image, jobs the root job wrote", () => {
	test("shows a request refused before its kind was known", async () => {
		await putJob(
			jobStatus({
				kind: null,
				state: "refused",
				step: "Refused",
				version: null,
				message: "unknown kind",
				finishedAt: "2026-09-28T10:00:01Z",
			}),
		);
		const res = await send(carol, "GET", "/admin/image");
		expect(res.statusCode).toBe(200);
		expect(res.json().job).toMatchObject({
			kind: null,
			state: "refused",
			message: "unknown kind",
		});
	});

	test("ignores a null kind on any state but refused", async () => {
		await putJob(jobStatus({ kind: null, state: "failed" }));
		const res = await send(carol, "GET", "/admin/image");
		expect(res.json().job).toBeNull();
	});

	test("a request the job has taken but not started is still waiting", async () => {
		const id = "22222222-2222-4222-8222-222222222222";
		await mkdir(join(jobsDir, id), { recursive: true });
		await writeFile(
			join(jobsDir, id, "request.json"),
			JSON.stringify({
				id,
				requestedAt: "2026-09-28T10:00:00Z",
				requestedBy: "33333333-3333-4333-8333-333333333333",
				request: { kind: "rollback" },
			}),
		);
		const res = await send(carol, "GET", "/admin/image");
		expect(res.json().job).toMatchObject({ id, kind: "rollback", state: "queued" });
		const busy = await send(carol, "POST", "/admin/image/jobs", { kind: "fetch" });
		expect(busy.statusCode).toBe(409);
	});
	test("reads the jobs before the aliases, so a finished job never shows the old default", async () => {
		await putJob(jobStatus({ state: "succeeded", step: "Done" }));
		const spy = vi.mocked(readFile);
		spy.mockClear();
		await send(carol, "GET", "/admin/image");
		const paths = spy.mock.calls.map(([path]) => String(path));
		const status = paths.findIndex((p) => p.endsWith("status.json"));
		const aliases = paths.findIndex((p) => p.endsWith("aliases.json"));
		expect(status).toBeGreaterThanOrEqual(0);
		expect(aliases).toBeGreaterThan(status);
	});
});

describe.skipIf(skip)("POST /admin/image/jobs", () => {
	test("writes one request file and audits it", async () => {
		const res = await send(carol, "POST", "/admin/image/jobs", {
			kind: "build",
			node: "26",
			python: "uv-3.14",
		});
		expect(res.statusCode).toBe(202);
		const job = res.json();
		expect(job.state).toBe("queued");
		expect(await requestFiles()).toEqual([`request-${job.id}.json`]);
		const file = JSON.parse(
			await readFile(join(jobsDir, `request-${job.id}.json`), "utf8"),
		);
		expect(file.request).toEqual({ kind: "build", node: "26", python: "uv-3.14" });
		expect(file.id).toBe(job.id);
		// Nothing else was written: no temporary file left, the store untouched.
		expect(await readdir(jobsDir)).toEqual([`request-${job.id}.json`]);
		const requested = await audits("image.job_requested");
		expect(requested).toHaveLength(1);
		expect(requested[0]?.target).toBe(job.id);

		const status = await send(carol, "GET", `/admin/image/jobs/${job.id}`);
		expect(status.json().job.state).toBe("queued");
	});

	test("refuses a second request while one is queued", async () => {
		expect(
			(await send(carol, "POST", "/admin/image/jobs", { kind: "fetch" })).statusCode,
		).toBe(202);
		const second = await send(carol, "POST", "/admin/image/jobs", { kind: "rollback" });
		expect(second.statusCode).toBe(409);
		expect(second.json().code).toBe("IMAGE_JOB_BUSY");
		expect(await requestFiles()).toHaveLength(1);
	});

	test("refuses a request while a job runs", async () => {
		await putJob(jobStatus());
		const res = await send(carol, "POST", "/admin/image/jobs", { kind: "fetch" });
		expect(res.statusCode).toBe(409);
		expect(res.json().code).toBe("IMAGE_JOB_BUSY");
		expect(await requestFiles()).toHaveLength(0);
	});

	test.each([
		{ kind: "delete" },
		{ kind: "build", node: "22", python: "debian" },
		{ kind: "build", node: "24", python: "pyenv" },
		{ kind: "build", node: "24", python: "debian", packages: ["x"] },
		{ kind: "fetch", version: "latest" },
		{ kind: "activate", version: "2026.09.9; id" },
		{ kind: "activate", version: "../2026.09.9" },
	])("refuses %j without writing", async (body) => {
		const res = await send(carol, "POST", "/admin/image/jobs", body);
		expect(res.statusCode).toBe(400);
		expect(await requestFiles()).toHaveLength(0);
		expect(await audits("image.job_requested")).toHaveLength(0);
	});

	test("refuses to activate an image that failed its health check", async () => {
		const res = await send(carol, "POST", "/admin/image/jobs", {
			kind: "activate",
			version: BROKEN,
		});
		expect(res.statusCode).toBe(409);
		expect(res.json().code).toBe("IMAGE_NOT_HEALTHY");
		expect(await requestFiles()).toHaveLength(0);
	});

	test("refuses to activate an image with no health result or no directory", async () => {
		await putImage("2026.09.11", manifest("2026.09.11"), null);
		for (const version of ["2026.09.11", "2026.09.99"]) {
			const res = await send(carol, "POST", "/admin/image/jobs", {
				kind: "activate",
				version,
			});
			expect(res.json().code).toBe("IMAGE_NOT_HEALTHY");
		}
	});

	test("refuses to activate the default", async () => {
		const res = await send(carol, "POST", "/admin/image/jobs", {
			kind: "activate",
			version: CURRENT,
		});
		expect(res.json().code).toBe("IMAGE_ALREADY_DEFAULT");
	});

	test("activates a healthy candidate", async () => {
		const res = await send(carol, "POST", "/admin/image/jobs", {
			kind: "activate",
			version: BUILT,
		});
		expect(res.statusCode).toBe(202);
	});

	test("refuses a rollback with no previous image", async () => {
		await writeFile(
			join(imagesDir, "aliases.json"),
			JSON.stringify({ default: CURRENT, previous: null }),
		);
		const res = await send(carol, "POST", "/admin/image/jobs", { kind: "rollback" });
		expect(res.statusCode).toBe(409);
		expect(res.json().code).toBe("IMAGE_NO_PREVIOUS");
	});

	test("queues a delete of a candidate and audits it", async () => {
		const res = await send(carol, "POST", "/admin/image/jobs", {
			kind: "delete",
			version: BUILT,
		});
		expect(res.statusCode).toBe(202);
		const file = JSON.parse(
			await readFile(join(jobsDir, `request-${res.json().id}.json`), "utf8"),
		);
		expect(file.request).toEqual({ kind: "delete", version: BUILT });
		const requested = await audits("image.job_requested");
		expect(requested[0]?.metadata).toEqual({ kind: "delete", version: BUILT });
	});

	test.each([
		["default", CURRENT],
		["previous", OLD],
	])("refuses to delete the %s image without writing", async (_role, version) => {
		const res = await send(carol, "POST", "/admin/image/jobs", {
			kind: "delete",
			version,
		});
		expect(res.statusCode).toBe(409);
		expect(res.json().code).toBe("IMAGE_IN_USE");
		expect(await requestFiles()).toHaveLength(0);
		expect(await audits("image.job_requested")).toHaveLength(0);
	});

	test("refuses to delete an image that is not on the host", async () => {
		const res = await send(carol, "POST", "/admin/image/jobs", {
			kind: "delete",
			version: "2026.09.99",
		});
		expect(res.statusCode).toBe(404);
		expect(await requestFiles()).toHaveLength(0);
	});

	test("is administrator-only", async () => {
		const res = await send(alice, "POST", "/admin/image/jobs", { kind: "fetch" });
		expect(res.statusCode).toBe(403);
		expect(await requestFiles()).toHaveLength(0);
	});

	test("is CSRF-checked: no Origin, no request", async () => {
		const res = await app.inject({
			method: "POST",
			url: "/admin/image/jobs",
			headers: { cookie: carol.cookieHeader() },
			payload: { kind: "fetch" },
		});
		expect(res.statusCode).toBe(403);
		const foreign = await app.inject({
			method: "POST",
			url: "/admin/image/jobs",
			headers: { cookie: carol.cookieHeader(), origin: "https://evil.example" },
			payload: { kind: "fetch" },
		});
		expect(foreign.statusCode).toBe(403);
		expect(await requestFiles()).toHaveLength(0);
	});
});

describe("tailLines", () => {
	test("reads only the end of a large log", async () => {
		const dir = await mkdtemp(join(tmpdir(), "portikus-tail-"));
		try {
			const path = join(dir, "log.txt");
			// About 20 MiB, far past the 256 KiB the tail may read.
			const lines = Array.from(
				{ length: 400_000 },
				(_, i) => `line ${i} ${"x".repeat(40)}`,
			);
			await writeFile(path, `${lines.join("\n")}\n`);
			vi.mocked(readFile).mockClear();
			const tail = await tailLines(path, 500);
			expect(tail).toHaveLength(500);
			expect(tail[0]).toBe(lines[399_500]);
			expect(tail.at(-1)).toBe(lines[399_999]);
			expect(vi.mocked(readFile)).not.toHaveBeenCalled();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("answers no lines for a missing log", async () => {
		expect(await tailLines(join(tmpdir(), "portikus-no-such-log.txt"), 500)).toEqual(
			[],
		);
	});
});

describe.skipIf(skip)("GET /admin/image/jobs/:id", () => {
	test("answers the status and the last 500 log lines", async () => {
		const lines = Array.from({ length: 700 }, (_, i) => `line ${i}`).join("\n");
		await putJob(jobStatus(), `${lines}\n`);
		const res = await send(carol, "GET", `/admin/image/jobs/${jobStatus().id}`);
		expect(res.statusCode).toBe(200);
		const body = res.json();
		expect(body.job.step).toBe("Downloading");
		expect(body.log).toHaveLength(500);
		expect(body.log[0]).toBe("line 200");
		expect(body.log.at(-1)).toBe("line 699");
	});

	test("refuses a malformed id and answers 404 for an unknown one", async () => {
		expect((await send(carol, "GET", "/admin/image/jobs/..%2F..")).statusCode).toBe(
			400,
		);
		expect(
			(
				await send(
					carol,
					"GET",
					"/admin/image/jobs/22222222-2222-4222-8222-222222222222",
				)
			).statusCode,
		).toBe(404);
	});

	test("is administrator-only", async () => {
		await putJob(jobStatus());
		expect(
			(await send(alice, "GET", `/admin/image/jobs/${jobStatus().id}`)).statusCode,
		).toBe(403);
	});
});

describe.skipIf(skip)("GET /admin/image/diff", () => {
	test("lists added, removed and changed packages and tools", async () => {
		const res = await send(
			carol,
			"GET",
			`/admin/image/diff?from=${CURRENT}&to=${BUILT}`,
		);
		expect(res.statusCode).toBe(200);
		const body = res.json();
		expect(body.packages).toEqual({
			added: [{ name: "zsh", version: "5.9-8" }],
			removed: [{ name: "git", version: "1:2.47.3-0" }],
			changed: [{ name: "curl", from: "8.14.1-2", to: "8.14.1-3" }],
		});
		expect(body.tools.changed).toEqual([
			{ name: "node", from: "v24.8.0", to: "v26.0.0" },
		]);
	});

	test("refuses a bad version and answers 404 for a missing manifest", async () => {
		expect(
			(await send(carol, "GET", "/admin/image/diff?from=../etc&to=2026.09.9"))
				.statusCode,
		).toBe(400);
		expect(
			(await send(carol, "GET", "/admin/image/diff?from=2026.09.9&to=2026.09.99"))
				.statusCode,
		).toBe(404);
	});

	test("is administrator-only", async () => {
		expect(
			(await send(alice, "GET", `/admin/image/diff?from=${CURRENT}&to=${BUILT}`))
				.statusCode,
		).toBe(403);
	});
});
