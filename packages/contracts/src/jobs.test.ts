import { describe, expect, test } from "vitest";
import { isJobActive, jobStaleAt } from "./jobs.js";

const STALE = 5 * 60_000;
const at = "2026-10-06T12:00:00.000Z";
const t = Date.parse(at);

describe("when a root job goes stale", () => {
	test("a queued job counts from its request, a running one from its start", () => {
		expect(
			jobStaleAt({ state: "queued", requestedAt: at, startedAt: null }, STALE),
		).toBe(t + STALE);
		const running = {
			state: "running",
			requestedAt: "2026-10-06T11:00:00.000Z",
			startedAt: at,
		};
		expect(jobStaleAt(running, STALE)).toBe(t + STALE);
	});

	test("a finished job never goes stale, and an unknown time never does either", () => {
		expect(
			jobStaleAt({ state: "succeeded", requestedAt: at, startedAt: at }, STALE),
		).toBeNull();
		expect(jobStaleAt(null, STALE)).toBeNull();
		const unknown = { state: "queued", requestedAt: null, startedAt: null };
		expect(isJobActive(unknown, STALE, t + 10 * STALE)).toBe(true);
	});

	test("active until the stale time, then not, for whatever limit is passed", () => {
		const job = { state: "running", requestedAt: null, startedAt: at };
		expect(isJobActive(job, STALE, t + STALE - 1)).toBe(true);
		expect(isJobActive(job, STALE, t + STALE)).toBe(false);
		expect(isJobActive(job, 3 * 3_600_000, t + STALE)).toBe(true);
	});
});
