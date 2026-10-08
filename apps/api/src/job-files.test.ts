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
import { CERTIFICATE_JOB_STALE_MS, IMAGE_JOB_STALE_MS } from "@portikus/contracts";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { allJobs as certificateJobs } from "./certificate/jobs.js";
import { currentJob, removeStaleRequests, writeRequestFile } from "./job-files.js";

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "job-files-"));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

test("writeRequestFile writes the request with the given mode and no temp file", async () => {
	await writeRequestFile(dir, { id: "abc" }, 0o640);
	const path = join(dir, "request-abc.json");
	expect(await readFile(path, "utf8")).toBe('{"id":"abc"}\n');
	expect((await stat(path)).mode & 0o777).toBe(0o640);
	expect(await readdir(dir)).toEqual(["request-abc.json"]);
});

test("writeRequestFile honours an owner-only mode", async () => {
	await writeRequestFile(dir, { id: "abc" }, 0o600);
	expect((await stat(join(dir, "request-abc.json"))).mode & 0o777).toBe(0o600);
});

test("writeRequestFile removes its temp file when the rename fails", async () => {
	// A directory at the target path makes the rename fail after the write.
	await mkdir(join(dir, "request-abc.json"));
	await expect(writeRequestFile(dir, { id: "abc" }, 0o600)).rejects.toThrow();
	expect(await readdir(dir)).toEqual(["request-abc.json"]);
});

describe("currentJob", () => {
	const NOW = Date.parse("2026-10-06T12:00:00Z");
	const STALE = 10 * 60_000;
	const ago = (ms: number) => new Date(NOW - ms).toISOString();
	let n = 0;
	const job = (fields: {
		state: string;
		requestedAt?: string | null;
		startedAt?: string | null;
	}) => ({ id: `job-${++n}`, requestedAt: null, startedAt: null, ...fields });

	test("is null with no jobs", () => {
		expect(currentJob([], STALE, NOW)).toBeNull();
	});

	test("a job killed while running never hides a newer finished or queued one", () => {
		const dead = job({
			state: "running",
			requestedAt: ago(STALE + 120_000),
			startedAt: ago(STALE + 60_000),
		});
		const finished = job({
			state: "succeeded",
			requestedAt: ago(60_000),
			startedAt: ago(59_000),
		});
		const queued = job({ state: "queued", requestedAt: ago(1000) });
		expect(currentJob([dead, finished], STALE, NOW)?.id).toBe(finished.id);
		expect(currentJob([dead, finished, queued], STALE, NOW)?.id).toBe(queued.id);
		// Even an older finished job ranks above the dead one.
		const older = job({ state: "failed", requestedAt: ago(STALE * 3) });
		expect(currentJob([dead, older], STALE, NOW)?.id).toBe(older.id);
	});

	test("a running job inside the limit stays current over an older finished one", () => {
		const finished = job({ state: "succeeded", requestedAt: ago(STALE * 2) });
		const running = job({
			state: "running",
			requestedAt: ago(STALE - 1000),
			startedAt: ago(STALE - 1000),
		});
		expect(currentJob([finished, running], STALE, NOW)?.id).toBe(running.id);
	});

	test("a dead queued request ranks below a new one waiting behind it", () => {
		const dead = job({ state: "queued", requestedAt: ago(STALE + 1000) });
		const waiting = job({ state: "queued", requestedAt: ago(1000) });
		expect(currentJob([dead, waiting], STALE, NOW)?.id).toBe(waiting.id);
	});

	test("the newest wins by request time, else start time", () => {
		const finished = job({ state: "succeeded", requestedAt: ago(30_000) });
		const noRequest = job({ state: "failed", startedAt: ago(5_000) });
		expect(currentJob([finished, noRequest], STALE, NOW)?.id).toBe(noRequest.id);
	});

	test("only dead jobs: the newest is still shown", () => {
		const a = job({
			state: "running",
			startedAt: ago(STALE * 2),
			requestedAt: ago(STALE * 2),
		});
		const b = job({ state: "queued", requestedAt: ago(STALE + 1) });
		expect(currentJob([a, b], STALE, NOW)?.id).toBe(b.id);
	});

	test("image tab: a build may run for hours, but a killed one does not hide the next", () => {
		const finished = job({ state: "succeeded", requestedAt: ago(5 * 3_600_000) });
		const build = job({
			state: "running",
			requestedAt: ago(2 * 3_600_000),
			startedAt: ago(2 * 3_600_000),
		});
		expect(currentJob([finished, build], IMAGE_JOB_STALE_MS, NOW)?.id).toBe(build.id);
		const killed = job({
			state: "running",
			requestedAt: ago(IMAGE_JOB_STALE_MS + 60_000),
			startedAt: ago(IMAGE_JOB_STALE_MS + 60_000),
		});
		const later = job({ state: "succeeded", requestedAt: ago(60_000) });
		expect(currentJob([killed, later], IMAGE_JOB_STALE_MS, NOW)?.id).toBe(later.id);
	});

	test("certificate tab: a killed job does not hide the next, a live one stays", () => {
		const killed = job({
			state: "running",
			requestedAt: ago(CERTIFICATE_JOB_STALE_MS + 60_000),
			startedAt: ago(CERTIFICATE_JOB_STALE_MS + 60_000),
		});
		const later = job({ state: "succeeded", requestedAt: ago(60_000) });
		expect(currentJob([killed, later], CERTIFICATE_JOB_STALE_MS, NOW)?.id).toBe(
			later.id,
		);
		const live = job({
			state: "running",
			startedAt: ago(20 * 60_000),
			requestedAt: ago(20 * 60_000),
		});
		const old = job({ state: "succeeded", requestedAt: ago(60 * 60_000) });
		expect(currentJob([old, live], CERTIFICATE_JOB_STALE_MS, NOW)?.id).toBe(live.id);
	});

	test("certificate tab: a rollback the job took but has not started outranks the finished renew", async () => {
		const renew = "11111111-1111-4111-8111-111111111111";
		const rollback = "22222222-2222-4222-8222-222222222222";
		const started = new Date(Date.now() - 5000).toISOString();
		await mkdir(join(dir, renew));
		await writeFile(
			join(dir, renew, "status.json"),
			JSON.stringify({
				id: renew,
				kind: "renew",
				state: "succeeded",
				step: "Done",
				message: null,
				restored: false,
				startedAt: started,
				finishedAt: started,
			}),
		);
		await mkdir(join(dir, rollback));
		await writeFile(
			join(dir, rollback, "request.json"),
			JSON.stringify({ kind: "rollback", settings: null }),
		);
		const job = currentJob(await certificateJobs(dir), CERTIFICATE_JOB_STALE_MS);
		expect(job?.id).toBe(rollback);
		expect(job?.state).toBe("queued");
	});
});

describe("removeStaleRequests", () => {
	const old = new Date(Date.now() - 2 * IMAGE_JOB_STALE_MS).toISOString();
	const queued = (id: string, requestedAt: string) => ({
		id,
		state: "queued",
		requestedAt,
		startedAt: null,
	});

	test("removes only stale queued request files", async () => {
		await writeFile(join(dir, "request-a.json"), "{}");
		await writeFile(join(dir, "request-b.json"), "{}");
		await removeStaleRequests(
			dir,
			[queued("a", old), queued("b", new Date().toISOString())],
			IMAGE_JOB_STALE_MS,
		);
		expect(await readdir(dir)).toEqual(["request-b.json"]);
	});

	test("a request file the job already took or removed is not an error", async () => {
		await expect(
			removeStaleRequests(dir, [queued("gone", old)], IMAGE_JOB_STALE_MS),
		).resolves.toBeUndefined();
	});
});
