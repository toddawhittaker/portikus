import type { Database } from "@portikus/db";
import { createTestDb, hasTestDb, type TestDb } from "@portikus/db/testing";
import { collectingLogger } from "@portikus/observability/testing";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { FakeControllerClient } from "./fake-controller.js";
import { createLogLevelSync } from "./log-level.js";

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
		.values({ id: 1, shutdown_grace_seconds: 600 })
		.execute();
});

async function setOverride(level: string | null): Promise<void> {
	await tdb.db
		.updateTable("settings")
		.set({ log_level: level })
		.where("id", "=", 1)
		.execute();
}

function build() {
	const { logger, lines } = collectingLogger();
	const controller = new FakeControllerClient();
	const tick = createLogLevelSync({
		db: tdb.db,
		logger,
		envLevel: "info",
		controller,
	});
	const pushes = () =>
		controller.calls.filter((c) => c.method === "setLogLevel").map((c) => c.args[0]);
	return { logger, lines, controller, tick, pushes };
}

test.skipIf(skip)(
	"with no override the tick pushes null once, so the controller keeps its own level",
	async () => {
		const { logger, tick, pushes } = build();

		await tick();
		await tick();

		expect(logger.level).toBe("info");
		expect(pushes()).toEqual([null]);
	},
);

test.skipIf(skip)("an override applies and is pushed to the controller", async () => {
	const { logger, tick, pushes } = build();
	await tick();

	await setOverride("debug");
	await tick();
	await tick();

	expect(logger.level).toBe("debug");
	expect(pushes()).toEqual([null, "debug"]);
});

test.skipIf(skip)(
	"clearing the override returns to the environment level",
	async () => {
		const { logger, tick, pushes } = build();
		await setOverride("error");
		await tick();
		expect(logger.level).toBe("error");

		await setOverride(null);
		await tick();

		expect(logger.level).toBe("info");
		expect(pushes()).toEqual(["error", null]);
	},
);

test.skipIf(skip)("a failed push is retried on the next tick", async () => {
	const { controller, tick, pushes, lines } = build();
	controller.setLogLevelResult = new Error("controller is down");

	await tick();
	expect(pushes()).toEqual([null]);
	expect(lines).toEqual([]);

	controller.setLogLevelResult = null;
	await tick();

	expect(pushes()).toEqual([null, null]);
});

test.skipIf(skip)("a failed push is logged at debug", async () => {
	const { controller, tick, lines } = build();
	controller.setLogLevelResult = new Error("controller is down");
	await setOverride("debug");

	await tick();

	const failure = lines.find(
		(line) => line.msg === "could not set the controller log level",
	);
	expect(failure).toBeDefined();
	expect(failure?.level).toBe("debug");
});

test("a database failure is logged at warn, not debug", async () => {
	const { logger, lines } = collectingLogger();
	// A database that refuses every read, so only the outer catch can run.
	const brokenDb = {
		selectFrom() {
			throw new Error("database is down");
		},
	} as unknown as Kysely<Database>;
	const tick = createLogLevelSync({
		db: brokenDb,
		logger,
		envLevel: "info",
		controller: new FakeControllerClient(),
	});

	await tick();

	const failure = lines.find((line) => line.msg === "log level sync failed");
	expect(failure).toBeDefined();
	expect(failure?.level).toBe("warn");
});

test.skipIf(skip)("a tick that lands while one is in flight is skipped", async () => {
	const { tick, pushes } = build();

	const first = tick();
	const second = tick();
	await Promise.all([first, second]);

	expect(pushes()).toEqual([null]);
});
