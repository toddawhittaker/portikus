import { createTestDb, hasTestDb, type TestDb } from "@portikus/db/testing";
import type { Logger, LogLevel } from "@portikus/observability";
import { collectingLogger } from "@portikus/observability/testing";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { type FakeAgent, startFakeAgent } from "./fake-agent.js";
import { startLogLevelSync } from "./log-level.js";

/** Workspace labels are unique, so each test row needs its own. */
let labelCounter = 0;
function testLabel(): string {
	return `ws-test-${++labelCounter}`;
}

/**
 * The API follows `settings.log_level` and relays it to each running
 * workspace's agent (ADR 0012, SPEC.md §25.6).
 */

const skip = !hasTestDb();
const AGENT_TOKEN = "log-level-test-token";

let testDb: TestDb;
let agent: FakeAgent;

async function setOverride(level: LogLevel | null): Promise<void> {
	await testDb.db
		.updateTable("settings")
		.set({ log_level: level })
		.where("id", "=", 1)
		.execute();
}

/** A student, because a workspace row is unique per owner. */
async function makeOwner(): Promise<string> {
	const user = await testDb.db
		.insertInto("users")
		.values({
			oidc_issuer: "http://mock",
			oidc_subject: `subject-${crypto.randomUUID()}`,
			display_name: "Student",
			email: null,
			role: "student",
			shutdown_grace_seconds: null,
		})
		.returning("id")
		.executeTakeFirstOrThrow();
	return user.id;
}

/** A workspace in the given state, pointed at the fake agent. */
async function makeWorkspace(state: string): Promise<string> {
	const row = await testDb.db
		.insertInto("workspaces")
		.values({
			label: testLabel(),
			owner_user_id: await makeOwner(),
			state,
			agent_address: "127.0.0.1",
			agent_token: AGENT_TOKEN,
		})
		.returning("id")
		.executeTakeFirstOrThrow();
	return row.id;
}

function startSync(logger: Logger) {
	// A long interval, because every test drives the sweep itself.
	return startLogLevelSync({
		db: testDb.db,
		logger,
		envLevel: "info",
		agentPort: agent.port,
		intervalMs: 60_000,
	});
}

beforeAll(async () => {
	if (skip) return;
	testDb = await createTestDb();
	agent = await startFakeAgent(AGENT_TOKEN);
});

afterAll(async () => {
	if (skip) return;
	await testDb.close();
	await agent.close();
});

beforeEach(async () => {
	if (skip) return;
	await testDb.truncate();
	agent.logLevels.length = 0;
	agent.failLogLevel = false;
	await testDb.db
		.insertInto("settings")
		.values({ id: 1, shutdown_grace_seconds: 600 })
		.execute();
});

test.skipIf(skip)("an override is applied and then cleared", async () => {
	const { logger, lines } = collectingLogger();
	const sync = startSync(logger);
	try {
		await setOverride("debug");
		await sync.tick();
		expect(logger.level).toBe("debug");

		await setOverride(null);
		await sync.tick();
		expect(logger.level).toBe("info");

		const changes = lines.filter((line) => line.msg === "log level changed");
		expect(changes).toHaveLength(2);
	} finally {
		sync.stop();
	}
});

test.skipIf(skip)(
	"clearing the override pushes null, so each agent keeps its own level",
	async () => {
		const { logger } = collectingLogger();
		const sync = startSync(logger);
		try {
			await makeWorkspace("running");
			await setOverride("debug");
			await sync.tick();
			expect(agent.logLevels).toEqual(["debug"]);

			await setOverride(null);
			await sync.tick();
			expect(agent.logLevels).toEqual(["debug", null]);
		} finally {
			sync.stop();
		}
	},
);

test.skipIf(skip)("each running workspace is pushed once, not every tick", async () => {
	const { logger } = collectingLogger();
	const sync = startSync(logger);
	try {
		await makeWorkspace("running");
		await makeWorkspace("running");
		await makeWorkspace("stopped");
		await setOverride("debug");

		await sync.tick();
		expect(agent.logLevels).toEqual(["debug", "debug"]);

		await sync.tick();
		expect(agent.logLevels).toEqual(["debug", "debug"]);
	} finally {
		sync.stop();
	}
});

test.skipIf(skip)(
	"a workspace that stops and starts again is pushed again",
	async () => {
		const { logger } = collectingLogger();
		const sync = startSync(logger);
		try {
			const id = await makeWorkspace("running");
			await setOverride("debug");
			await sync.tick();
			expect(agent.logLevels).toHaveLength(1);

			await testDb.db
				.updateTable("workspaces")
				.set({ state: "stopped", updated_at: new Date().toISOString() })
				.where("id", "=", id)
				.execute();
			await sync.tick();
			expect(agent.logLevels).toHaveLength(1);

			await testDb.db
				.updateTable("workspaces")
				.set({ state: "running", updated_at: new Date().toISOString() })
				.where("id", "=", id)
				.execute();
			await sync.tick();
			expect(agent.logLevels).toEqual(["debug", "debug"]);
		} finally {
			sync.stop();
		}
	},
);

test.skipIf(skip)("a failed push is logged at debug and tried again", async () => {
	const { logger, lines } = collectingLogger("debug");
	const sync = startSync(logger);
	try {
		await makeWorkspace("running");
		// The override must be debug, or it would filter out the line below.
		await setOverride("debug");

		agent.failLogLevel = true;
		await sync.tick();
		expect(agent.logLevels).toEqual([]);
		expect(
			lines.some(
				(line) =>
					line.level === "debug" &&
					line.msg === "could not set the workspace agent log level",
			),
		).toBe(true);

		agent.failLogLevel = false;
		await sync.tick();
		expect(agent.logLevels).toEqual(["debug"]);
	} finally {
		sync.stop();
	}
});

test.skipIf(skip)("a second sweep started while one runs does nothing", async () => {
	const { logger } = collectingLogger();
	const sync = startSync(logger);
	try {
		await makeWorkspace("running");
		await setOverride("debug");

		// Both start before either finishes; the guard must drop the second.
		await Promise.all([sync.tick(), sync.tick()]);
		expect(agent.logLevels).toEqual(["debug"]);
	} finally {
		sync.stop();
	}
});
