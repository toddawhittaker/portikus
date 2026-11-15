/**
 * The nightly coding-agents update (docs/SPEC.md section 22.6): it starts
 * the existing `agents-update` job only when the setting is on, the daily
 * check recorded a newer version, and no image job waits or runs, and it
 * tries once a night.
 */
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ImageJobView } from "@portikus/contracts";
import { createTestDb, hasTestDb, type TestDb } from "@portikus/db/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import {
	AUTO_UPDATE_HOUR,
	decideAgentsAutoUpdate,
	runAgentsAutoUpdate,
} from "./agents-auto-update.js";
import { imageJobLock } from "./image-jobs.js";

/** UTC on a fixed night, so the test does not depend on the clock or the zone. */
function at(day: number, hour: number, minute = 10): Date {
	return new Date(Date.UTC(2026, 10, day, hour, minute));
}

const TONIGHT = at(14, AUTO_UPDATE_HOUR);
const NEWER = { claude: null, codex: "0.166.0" };

function job(state: ImageJobView["state"], startedAt: Date): ImageJobView {
	return {
		id: "11111111-1111-4111-8111-111111111111",
		kind: "build",
		state,
		step: "Building",
		version: null,
		message: null,
		requestedAt: startedAt.toISOString(),
		startedAt: startedAt.toISOString(),
		finishedAt: state === "running" ? null : startedAt.toISOString(),
		request: null,
	};
}

describe("decideAgentsAutoUpdate", () => {
	const base = {
		enabled: true,
		now: TONIGHT,
		lastAttemptAt: null,
		newer: NEWER,
		jobs: [],
	};

	test("starts when the setting is on and either tool has a newer version", () => {
		expect(decideAgentsAutoUpdate(base)).toBe("start");
		expect(
			decideAgentsAutoUpdate({ ...base, newer: { claude: "2.1.0", codex: null } }),
		).toBe("start");
	});

	test("does nothing with the setting off", () => {
		expect(decideAgentsAutoUpdate({ ...base, enabled: false })).toBe("off");
	});

	test("does nothing when no newer version was recorded", () => {
		expect(
			decideAgentsAutoUpdate({ ...base, newer: { claude: null, codex: null } }),
		).toBe("up-to-date");
	});

	test("waits while another image job runs or is queued", () => {
		const running = job("running", new Date(TONIGHT.getTime() - 60_000));
		expect(decideAgentsAutoUpdate({ ...base, jobs: [running] })).toBe("busy");
		const queued = { ...running, state: "queued" as const, startedAt: null };
		expect(decideAgentsAutoUpdate({ ...base, jobs: [queued] })).toBe("busy");
		const done = job("succeeded", new Date(TONIGHT.getTime() - 60_000));
		expect(decideAgentsAutoUpdate({ ...base, jobs: [done] })).toBe("start");
	});

	test("tries once a night, and a failure the night before does not stop tonight", () => {
		const earlierTonight = at(14, AUTO_UPDATE_HOUR, 0);
		expect(decideAgentsAutoUpdate({ ...base, lastAttemptAt: earlierTonight })).toBe(
			"tried-tonight",
		);
		const lastNight = at(13, AUTO_UPDATE_HOUR, 5);
		expect(
			decideAgentsAutoUpdate({
				...base,
				lastAttemptAt: lastNight,
				jobs: [{ ...job("failed", lastNight), kind: "agents-update" }],
			}),
		).toBe("start");
	});

	test("the hour is 08:00 to 09:00 UTC, 03:00 US Eastern standard time", () => {
		expect(AUTO_UPDATE_HOUR).toBe(8);
		expect(decideAgentsAutoUpdate({ ...base, now: at(14, 7, 59) })).toBe("not-tonight");
		expect(decideAgentsAutoUpdate({ ...base, now: at(14, 8, 0) })).toBe("start");
		expect(decideAgentsAutoUpdate({ ...base, now: at(14, 8, 59) })).toBe("start");
		expect(decideAgentsAutoUpdate({ ...base, now: at(14, 9, 0) })).toBe("not-tonight");
		expect(decideAgentsAutoUpdate({ ...base, now: at(14, 3, 0) })).toBe("not-tonight");
	});

	test("runs only in its hour of the night", () => {
		expect(decideAgentsAutoUpdate({ ...base, now: at(14, 14) })).toBe("not-tonight");
		expect(decideAgentsAutoUpdate({ ...base, now: at(14, AUTO_UPDATE_HOUR + 1) })).toBe(
			"not-tonight",
		);
	});
});

const skip = !hasTestDb();
if (skip) console.log("TEST_DATABASE_URL is not set — skipping auto-update run tests.");

describe.skipIf(skip)("runAgentsAutoUpdate", () => {
	let t: TestDb;
	let root: string;
	let jobsDir: string;
	let imagesDir: string;

	beforeAll(async () => {
		t = await createTestDb();
	});
	afterAll(async () => {
		await t?.close();
	});
	beforeEach(async () => {
		await t.truncate();
		if (root) await rm(root, { recursive: true, force: true });
		root = await mkdtemp(join(tmpdir(), "agents-auto-"));
		jobsDir = join(root, "image-jobs");
		imagesDir = join(root, "images");
		await mkdir(jobsDir);
		await mkdir(imagesDir);
		await writeFile(
			join(imagesDir, "coding-agents.json"),
			JSON.stringify({
				claude: { current: "2.1.0", previous: null, kept: ["2.1.0"] },
				codex: { current: "0.162.1", previous: null, kept: ["0.162.1"] },
				updatedAt: "2026-11-01T00:00:00Z",
			}),
		);
		await writeFile(
			join(imagesDir, "published.json"),
			JSON.stringify({
				checkedAt: "2026-11-13T06:00:00Z",
				image: null,
				package: null,
				codingAgents: { claude: "2.1.0", codex: "0.166.0" },
			}),
		);
	});

	async function setting(on: boolean): Promise<void> {
		await t.db
			.insertInto("settings")
			.values({ id: 1, shutdown_grace_seconds: 30, coding_agents_auto_update: on })
			.execute();
	}

	async function requestFiles(): Promise<string[]> {
		return (await readdir(jobsDir)).filter((name) => name.startsWith("request-"));
	}

	test("a new site has the setting off, and nothing is queued", async () => {
		await t.db
			.insertInto("settings")
			.values({ id: 1, shutdown_grace_seconds: 30 })
			.execute();
		expect(await runAgentsAutoUpdate(t.db, jobsDir, imagesDir, TONIGHT)).toBe("off");
		expect(await requestFiles()).toEqual([]);
	});

	test("queues agents-update as the system and audits it like a button press", async () => {
		await setting(true);
		expect(await runAgentsAutoUpdate(t.db, jobsDir, imagesDir, TONIGHT)).toBe("start");
		const [name] = await requestFiles();
		if (!name) throw new Error("no request file");
		const file = JSON.parse(await readFile(join(jobsDir, name), "utf8"));
		expect(file.requestedBy).toBe("system");
		expect(file.request).toEqual({ kind: "agents-update" });
		const audit = await t.db
			.selectFrom("audit_events")
			.select(["actor", "action", "target", "result", "metadata"])
			.execute();
		expect(audit).toEqual([
			{
				actor: "system",
				action: "image.job_requested",
				target: file.id,
				result: "ok",
				metadata: { kind: "agents-update" },
			},
		]);
		// The request is now queued, and tonight's one attempt is spent.
		expect(await runAgentsAutoUpdate(t.db, jobsDir, imagesDir, TONIGHT)).toBe(
			"tried-tonight",
		);
		expect(await requestFiles()).toHaveLength(1);
	});

	test("leaves a running job alone", async () => {
		await setting(true);
		const id = "22222222-2222-4222-8222-222222222222";
		await mkdir(join(jobsDir, id));
		await writeFile(
			join(jobsDir, id, "status.json"),
			JSON.stringify({
				id,
				kind: "build",
				state: "running",
				step: "Building",
				version: null,
				message: null,
				startedAt: TONIGHT.toISOString(),
				finishedAt: null,
			}),
		);
		expect(await runAgentsAutoUpdate(t.db, jobsDir, imagesDir, TONIGHT)).toBe("busy");
		expect(await requestFiles()).toEqual([]);
	});

	test("waits while an administrator's request is being written", async () => {
		await setting(true);
		imageJobLock.held = true;
		try {
			expect(await runAgentsAutoUpdate(t.db, jobsDir, imagesDir, TONIGHT)).toBe("busy");
		} finally {
			imageJobLock.held = false;
		}
	});
});
