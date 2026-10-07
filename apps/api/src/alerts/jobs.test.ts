import {
	isJobActive,
	NOTIFY_JOB_STALE_MS,
	type NotifyJobView,
} from "@portikus/contracts";
import { describe, expect, test } from "vitest";
import { currentJob } from "../job-files.js";

const NOW = Date.parse("2026-10-06T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

let next = 0;
function job(over: Partial<NotifyJobView>): NotifyJobView {
	next += 1;
	return {
		id: `00000000-0000-4000-8000-${String(next).padStart(12, "0")}`,
		state: "succeeded",
		code: null,
		channels: [],
		hosts: [],
		requestedAt: null,
		startedAt: null,
		finishedAt: null,
		...over,
	};
}

describe("isJobActive with the notify stale limit", () => {
	test("a queued or running job is active until NOTIFY_JOB_STALE_MS has passed", () => {
		expect(
			isJobActive(
				job({ state: "queued", requestedAt: ago(60_000) }),
				NOTIFY_JOB_STALE_MS,
				NOW,
			),
		).toBe(true);
		expect(
			isJobActive(
				job({ state: "queued", requestedAt: ago(NOTIFY_JOB_STALE_MS) }),
				NOTIFY_JOB_STALE_MS,
				NOW,
			),
		).toBe(false);
		expect(
			isJobActive(
				job({
					state: "running",
					requestedAt: ago(NOTIFY_JOB_STALE_MS * 2),
					startedAt: ago(1000),
				}),
				NOTIFY_JOB_STALE_MS,
				NOW,
			),
		).toBe(true);
		expect(
			isJobActive(
				job({ state: "succeeded", requestedAt: ago(1000) }),
				NOTIFY_JOB_STALE_MS,
				NOW,
			),
		).toBe(false);
	});
});

describe("currentJob with the notify stale limit", () => {
	test("is null with no jobs", () => {
		expect(currentJob([], NOTIFY_JOB_STALE_MS, NOW)).toBeNull();
	});

	test("a job killed while running never hides the jobs after it", () => {
		const dead = job({
			state: "running",
			requestedAt: ago(NOTIFY_JOB_STALE_MS + 60_000),
			startedAt: ago(NOTIFY_JOB_STALE_MS + 60_000),
		});
		const older = job({
			state: "succeeded",
			requestedAt: ago(NOTIFY_JOB_STALE_MS * 3),
		});
		const newer = job({
			state: "refused",
			requestedAt: ago(60_000),
			startedAt: ago(59_000),
		});
		expect(currentJob([dead, older, newer], NOTIFY_JOB_STALE_MS, NOW)?.id).toBe(
			newer.id,
		);
		// Even an older finished job ranks above the dead one.
		expect(currentJob([dead, older], NOTIFY_JOB_STALE_MS, NOW)?.id).toBe(older.id);
	});

	test("a dead queued request ranks below a new one waiting behind it", () => {
		const dead = job({ state: "queued", requestedAt: ago(NOTIFY_JOB_STALE_MS + 1000) });
		const waiting = job({ state: "queued", requestedAt: ago(1000) });
		expect(currentJob([dead, waiting], NOTIFY_JOB_STALE_MS, NOW)?.id).toBe(waiting.id);
	});

	test("among live and finished jobs the newest wins, by request time, else start time", () => {
		const finished = job({ state: "succeeded", requestedAt: ago(30_000) });
		const running = job({
			state: "running",
			requestedAt: ago(10_000),
			startedAt: ago(9_000),
		});
		expect(currentJob([finished, running], NOTIFY_JOB_STALE_MS, NOW)?.id).toBe(
			running.id,
		);
		const noRequest = job({ state: "failed", startedAt: ago(5_000) });
		expect(currentJob([finished, noRequest], NOTIFY_JOB_STALE_MS, NOW)?.id).toBe(
			noRequest.id,
		);
	});

	test("only dead jobs: the newest of them is still shown, so the page can say it did not finish", () => {
		const a = job({
			state: "running",
			startedAt: ago(NOTIFY_JOB_STALE_MS * 2),
			requestedAt: ago(NOTIFY_JOB_STALE_MS * 2),
		});
		const b = job({ state: "queued", requestedAt: ago(NOTIFY_JOB_STALE_MS + 1) });
		expect(currentJob([a, b], NOTIFY_JOB_STALE_MS, NOW)?.id).toBe(b.id);
	});
});
