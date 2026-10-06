import {
	isNotifyJobActive,
	NOTIFY_JOB_STALE_MS,
	type NotifyJobView,
} from "@portikus/contracts";
import { describe, expect, test } from "vitest";
import { latestJob } from "./jobs.js";

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

describe("isNotifyJobActive", () => {
	test("a queued or running job is active until NOTIFY_JOB_STALE_MS has passed", () => {
		expect(
			isNotifyJobActive(job({ state: "queued", requestedAt: ago(60_000) }), NOW),
		).toBe(true);
		expect(
			isNotifyJobActive(
				job({ state: "queued", requestedAt: ago(NOTIFY_JOB_STALE_MS) }),
				NOW,
			),
		).toBe(false);
		expect(
			isNotifyJobActive(
				job({
					state: "running",
					requestedAt: ago(NOTIFY_JOB_STALE_MS * 2),
					startedAt: ago(1000),
				}),
				NOW,
			),
		).toBe(true);
		expect(
			isNotifyJobActive(job({ state: "succeeded", requestedAt: ago(1000) }), NOW),
		).toBe(false);
	});
});

describe("latestJob", () => {
	test("is null with no jobs", () => {
		expect(latestJob([], NOW)).toBeNull();
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
		expect(latestJob([dead, older, newer], NOW)?.id).toBe(newer.id);
		// Even an older finished job ranks above the dead one.
		expect(latestJob([dead, older], NOW)?.id).toBe(older.id);
	});

	test("a dead queued request ranks below a new one waiting behind it", () => {
		const dead = job({ state: "queued", requestedAt: ago(NOTIFY_JOB_STALE_MS + 1000) });
		const waiting = job({ state: "queued", requestedAt: ago(1000) });
		expect(latestJob([dead, waiting], NOW)?.id).toBe(waiting.id);
	});

	test("among live and finished jobs the newest wins, by request time, else start time", () => {
		const finished = job({ state: "succeeded", requestedAt: ago(30_000) });
		const running = job({
			state: "running",
			requestedAt: ago(10_000),
			startedAt: ago(9_000),
		});
		expect(latestJob([finished, running], NOW)?.id).toBe(running.id);
		const noRequest = job({ state: "failed", startedAt: ago(5_000) });
		expect(latestJob([finished, noRequest], NOW)?.id).toBe(noRequest.id);
	});

	test("only dead jobs: the newest of them is still shown, so the page can say it did not finish", () => {
		const a = job({
			state: "running",
			startedAt: ago(NOTIFY_JOB_STALE_MS * 2),
			requestedAt: ago(NOTIFY_JOB_STALE_MS * 2),
		});
		const b = job({ state: "queued", requestedAt: ago(NOTIFY_JOB_STALE_MS + 1) });
		expect(latestJob([a, b], NOW)?.id).toBe(b.id);
	});
});
