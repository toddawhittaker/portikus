import type { SeedBuildRequest } from "@portikus/contracts";
import { createTestDb, hasTestDb, type TestDb } from "@portikus/db/testing";
import { collectingLogger } from "@portikus/observability/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { ControllerClientError } from "./controller-client.js";
import { createSeedJobs } from "./docker-seed-jobs.js";
import { FakeControllerClient } from "./fake-controller.js";

const skip = !hasTestDb();
let tdb: TestDb;

beforeAll(async () => {
	if (skip) return;
	tdb = await createTestDb();
});

afterAll(async () => {
	if (skip) return;
	await tdb.close();
});

beforeEach(async () => {
	if (skip) return;
	await tdb.truncate();
	await tdb.db
		.insertInto("settings")
		.values({ id: 1, shutdown_grace_seconds: 600, docker_seed_max_gib: 5 })
		.execute();
});

async function queue(images = ["redis:7", "node:22"]): Promise<string> {
	const row = await tdb.db
		.insertInto("docker_seed_jobs")
		.values({ images: JSON.stringify(images) })
		.returning("id")
		.executeTakeFirstOrThrow();
	return row.id;
}

async function job(id: string) {
	return tdb.db
		.selectFrom("docker_seed_jobs")
		.selectAll()
		.where("id", "=", id)
		.executeTakeFirstOrThrow();
}

function build() {
	const controller = new FakeControllerClient();
	const { logger } = collectingLogger();
	const tick = createSeedJobs({ db: tdb.db, controller, logger });
	return { controller, tick };
}

const SEED = {
	images: ["redis:7", "node:22"],
	sizeBytes: 2 * 1024 ** 3,
	imageVersion: "2026.09.15",
	builtAt: "2026-09-30T10:00:00.000Z",
};

describe.skipIf(skip)("seed jobs (ruling S8)", () => {
	test("starts a queued job with the size cap as maxBytes and the ghcr switch", async () => {
		const id = await queue();
		const { controller, tick } = build();
		await tick();
		const call = controller.calls.find((c) => c.method === "startSeedBuild");
		expect(call?.args[0]).toEqual({
			id,
			images: ["redis:7", "node:22"],
			ghcrEnabled: false,
			maxBytes: 5 * 1024 ** 3,
		} satisfies SeedBuildRequest);
		expect(await job(id)).toMatchObject({ state: "running", step: "Starting" });
	});

	test("polls a running job, copies its step, and on success writes the seed", async () => {
		const id = await queue();
		const { controller, tick } = build();
		await tick();
		controller.seedBuildResult = (bid) => ({
			id: bid,
			state: "running",
			step: "Pulling node:22 (2 of 2)",
			message: null,
			seed: null,
		});
		await tick();
		expect((await job(id)).step).toBe("Pulling node:22 (2 of 2)");

		controller.seedBuildResult = (bid) => ({
			id: bid,
			state: "succeeded",
			step: "Done",
			message: null,
			seed: SEED,
		});
		await tick();
		const done = await job(id);
		expect(done.state).toBe("succeeded");
		expect(done.finished_at).not.toBeNull();
		const seed = await tdb.db
			.selectFrom("docker_seed")
			.selectAll()
			.executeTakeFirstOrThrow();
		expect(seed.images).toEqual(SEED.images);
		expect(Number(seed.size_bytes)).toBe(SEED.sizeBytes);
		expect(seed.image_version).toBe("2026.09.15");

		// A later success replaces the one seed row.
		const second = await queue(["python:3.12"]);
		controller.seedBuildResult = (bid) => ({
			id: bid,
			state: "succeeded",
			step: "Done",
			message: null,
			seed: { ...SEED, images: ["python:3.12"] },
		});
		await tick();
		await tick();
		expect((await job(second)).state).toBe("succeeded");
		const rows = await tdb.db.selectFrom("docker_seed").selectAll().execute();
		expect(rows.map((r) => r.images)).toEqual([["python:3.12"]]);
	});

	test("a failed build keeps the old seed and records the message", async () => {
		await tdb.db
			.insertInto("docker_seed")
			.values({
				images: JSON.stringify(["redis:7"]),
				size_bytes: 1,
				image_version: "old",
				built_at: "2026-09-01T00:00:00.000Z",
			})
			.execute();
		const id = await queue();
		const { controller, tick } = build();
		controller.startSeedBuildResult = (req) => ({
			id: req.id,
			state: "failed",
			step: "Measuring",
			message: "The seed is larger than 5 GiB.",
			seed: null,
		});
		await tick();
		expect(await job(id)).toMatchObject({
			state: "failed",
			message: "The seed is larger than 5 GiB.",
		});
		const seed = await tdb.db
			.selectFrom("docker_seed")
			.selectAll()
			.executeTakeFirstOrThrow();
		expect(seed.image_version).toBe("old");
	});

	test("a restart resumes by id; a controller that forgot the id fails the job", async () => {
		const id = await queue();
		await tdb.db.updateTable("docker_seed_jobs").set({ state: "running" }).execute();
		const { controller, tick } = build();
		controller.seedBuildResult = new ControllerClientError("NOT_FOUND", "no build");
		await tick();
		expect(controller.calls.map((c) => c.method)).toEqual(["seedBuild"]);
		const failed = await job(id);
		expect(failed.state).toBe("failed");
		expect(failed.message).toMatch(/lost/);
	});

	test("an unreachable controller leaves the job queued for the next tick", async () => {
		const id = await queue();
		const { controller, tick } = build();
		controller.startSeedBuildResult = new ControllerClientError(
			"INCUS_UNAVAILABLE",
			"down",
		);
		controller.seedBuildResult = new ControllerClientError("NOT_FOUND", "no build");
		await tick();
		expect((await job(id)).state).toBe("queued");
	});

	test("a refused request fails the job", async () => {
		const id = await queue();
		const { controller, tick } = build();
		controller.startSeedBuildResult = new ControllerClientError(
			"BAD_REQUEST",
			"ghcr.io names need the ghcr.io cache",
		);
		await tick();
		expect(await job(id)).toMatchObject({
			state: "failed",
			message: "ghcr.io names need the ghcr.io cache",
		});
	});
});
