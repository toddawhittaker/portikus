import { Writable } from "node:stream";
import { createTestDb, hasTestDb, type TestDb } from "@portikus/db/testing";
import { createLogger, type Logger } from "@portikus/observability";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { FakeControllerClient } from "./fake-controller.js";
import { createLogLevelSync } from "./log-level.js";

/** A logger whose lines are collected in memory, so tests can read them. */
function collectingLogger(): { logger: Logger; lines: Record<string, unknown>[] } {
	const lines: Record<string, unknown>[] = [];
	const destination = new Writable({
		write(chunk, _encoding, callback) {
			for (const text of String(chunk).split("\n")) {
				if (text.trim() !== "") lines.push(JSON.parse(text));
			}
			callback();
		},
	});
	return {
		logger: createLogger({ service: "worker", level: "info", destination }),
		lines,
	};
}

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
	"with no override the tick pushes the environment level once",
	async () => {
		const { logger, tick, pushes } = build();

		await tick();
		await tick();

		expect(logger.level).toBe("info");
		expect(pushes()).toEqual(["info"]);
	},
);

test.skipIf(skip)("an override applies and is pushed to the controller", async () => {
	const { logger, tick, pushes } = build();
	await tick();

	await setOverride("debug");
	await tick();
	await tick();

	expect(logger.level).toBe("debug");
	expect(pushes()).toEqual(["info", "debug"]);
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
		expect(pushes()).toEqual(["error", "info"]);
	},
);

test.skipIf(skip)("a failed push is retried on the next tick", async () => {
	const { controller, tick, pushes, lines } = build();
	controller.setLogLevelResult = new Error("controller is down");

	await tick();
	expect(pushes()).toEqual(["info"]);
	expect(lines.some((line) => line.msg === "log level sync failed")).toBe(false);

	controller.setLogLevelResult = null;
	await tick();

	expect(pushes()).toEqual(["info", "info"]);
});

test.skipIf(skip)("a failed push is logged at debug", async () => {
	const { controller, tick, lines } = build();
	controller.setLogLevelResult = new Error("controller is down");
	await setOverride("debug");

	await tick();

	const failure = lines.find((line) => line.msg === "log level sync failed");
	expect(failure).toBeDefined();
	expect(failure?.level).toBe("debug");
});

test.skipIf(skip)("a tick that lands while one is in flight is skipped", async () => {
	const { tick, pushes } = build();

	const first = tick();
	const second = tick();
	await Promise.all([first, second]);

	expect(pushes()).toEqual(["info"]);
});
