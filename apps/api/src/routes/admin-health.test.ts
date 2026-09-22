import {
	CookieJar,
	csrfHeaders,
	loginAs,
	type MockOidcProvider,
	startMockOidcProvider,
} from "@portikus/auth/testing";
import { HealthReport, type HealthSample } from "@portikus/contracts";
import { createTestDb, hasTestDb, type TestDb } from "@portikus/db/testing";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { type FakeAgent, startFakeAgent } from "../fake-agent.js";
import { buildTestServer, PUBLIC_URL } from "../test-support.js";

const skip = !hasTestDb();
const AGENT_TOKEN = "health-agent-token";
const GiB = 1024 ** 3;
let testDb: TestDb;
let mock: MockOidcProvider;
let agent: FakeAgent;
let app: FastifyInstance;
let carol: CookieJar;

beforeAll(async () => {
	if (skip) return;
	testDb = await createTestDb();
	mock = await startMockOidcProvider({
		redirectUris: [`${PUBLIC_URL}/auth/callback`],
	});
	agent = await startFakeAgent(AGENT_TOKEN);
});

afterAll(async () => {
	if (skip) return;
	await testDb.close();
	await mock.close();
	await agent.close();
});

beforeEach(async () => {
	if (skip) return;
	await testDb.truncate();
	await testDb.db.deleteFrom("health_samples").execute();
	app = buildTestServer(testDb.db, mock.issuer, { AGENT_PORT: agent.port });
	await app.ready();
	carol = new CookieJar();
	await loginAs(app, "carol", carol);
	return async () => {
		await app.close();
	};
});

function sample(
	poolUsedGiB: number,
	memoryUsedGiB: number,
	load1: number,
): HealthSample {
	return {
		controller: { reachable: true, errorCode: null },
		host: {
			observedAt: new Date().toISOString(),
			loadAverage: [load1, 0.5, 0.25],
			cpuCount: 8,
			memory: { usedBytes: memoryUsedGiB * GiB, totalBytes: 32 * GiB },
			pool: { name: "portikus", usedBytes: poolUsedGiB * GiB, totalBytes: 500 * GiB },
			profileLimits: { cpu: "2", memory: "4GiB", processes: "2000" },
			image: { fingerprint: "abc123def4567890", serial: "2026.09.9" },
			instances: [
				{ name: "ws-secret-name", imageFingerprint: "abc", imageSerial: "2026.09.9" },
			],
		},
	};
}

async function seedSample(value: HealthSample, minutesAgo: number): Promise<void> {
	await testDb.db
		.insertInto("health_samples")
		.values({
			sample: JSON.stringify(value),
			observed_at: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
		} as never)
		.execute();
}

async function getHealth(jar: CookieJar = carol) {
	return app.inject({
		method: "GET",
		url: "/admin/health",
		headers: { cookie: jar.cookieHeader() },
	});
}

/** A workspace in the given state, with the fake agent behind it or not. */
async function workspace(
	subject: string,
	state: string,
	agentAddress: string | null,
): Promise<void> {
	const jar = new CookieJar();
	await loginAs(app, subject, jar);
	const id = (
		await app.inject({
			method: "POST",
			url: "/workspaces",
			headers: csrfHeaders(jar, PUBLIC_URL),
		})
	).json().id;
	await testDb.db
		.updateTable("workspaces")
		.set({
			state,
			agent_address: agentAddress,
			agent_token: `${AGENT_TOKEN}:${id}`,
			updated_at: new Date().toISOString(),
		})
		.where("id", "=", id)
		.execute();
}

test.skipIf(skip)("only an administrator may read health", async () => {
	expect((await app.inject({ method: "GET", url: "/admin/health" })).statusCode).toBe(
		401,
	);
	const alice = new CookieJar();
	await loginAs(app, "alice", alice);
	expect((await getHealth(alice)).statusCode).toBe(403);
});

test.skipIf(skip)("with no sample the worker is stale and host is null", async () => {
	const report = HealthReport.parse((await getHealth()).json());
	expect(report.sampledAt).toBeNull();
	expect(report.workerStale).toBe(true);
	expect(report.host).toBeNull();
	expect(report.series).toEqual([]);
	expect(report.controller.reachable).toBe(false);
});

test.skipIf(skip)("reports the newest sample and fifteen-minute maxima", async () => {
	// Two samples in one fifteen-minute bucket 3 hours ago, one a day and a
	// half ago that falls outside the series, and the newest one now.
	await seedSample(sample(100, 10, 1), 180);
	await seedSample(sample(300, 20, 3), 181);
	await seedSample(sample(450, 30, 9), 36 * 60);
	await seedSample(sample(410, 12, 2), 0);

	const res = await getHealth();
	expect(res.statusCode).toBe(200);
	const report = HealthReport.parse(res.json());
	expect(report.workerStale).toBe(false);
	expect(report.controller).toEqual({ reachable: true, errorCode: null });
	expect(report.host?.pool).toEqual({ usedBytes: 410 * GiB, totalBytes: 500 * GiB });
	expect(report.host?.image.serial).toBe("2026.09.9");
	expect(report.host?.profileLimits.memory).toBe("4GiB");
	// Instance names stay out of the report.
	expect(res.body).not.toContain("ws-secret-name");

	expect(report.series.length).toBeGreaterThanOrEqual(2);
	expect(report.series.length).toBeLessThanOrEqual(3);
	const maxima = report.series.find((point) => point.poolUsedBytes === 300 * GiB);
	expect(maxima?.memoryUsedBytes).toBe(20 * GiB);
	expect(maxima?.load1).toBe(3);
	expect(report.series.some((point) => point.load1 === 9)).toBe(false);
	const times = report.series.map((point) => point.at);
	expect(times).toEqual([...times].sort());
	for (const point of report.series) {
		expect(new Date(point.at).getUTCMinutes() % 15).toBe(0);
	}
});

test.skipIf(skip)("a sample older than two minutes flags the worker", async () => {
	await seedSample(sample(10, 1, 0.1), 3);
	const report = HealthReport.parse((await getHealth()).json());
	expect(report.workerStale).toBe(true);
	expect(report.host).not.toBeNull();
});

test.skipIf(skip)("an unreachable controller sample has no host facts", async () => {
	await seedSample(
		{
			controller: { reachable: false, errorCode: "CONTROLLER_UNREACHABLE" },
			host: null,
		},
		0,
	);
	const report = HealthReport.parse((await getHealth()).json());
	expect(report.workerStale).toBe(false);
	expect(report.controller).toEqual({
		reachable: false,
		errorCode: "CONTROLLER_UNREACHABLE",
	});
	expect(report.host).toBeNull();
	expect(report.series).toEqual([]);
});

test.skipIf(skip)("counts workspaces by state and probes running agents", async () => {
	await workspace("alice", "running", "127.0.0.1");
	// Nothing listens on this address, so this agent does not answer.
	await workspace("bob", "running", "127.0.0.2");
	await workspace("carol", "stopped", null);

	const report = HealthReport.parse((await getHealth()).json());
	expect(report.workspacesByState).toEqual({ running: 2, stopped: 1 });
	expect(report.agents).toEqual({ answering: 1, running: 2 });
});

test.skipIf(skip)("counts the last day's failures from the audit log", async () => {
	const recent = new Date().toISOString();
	const old = new Date(Date.now() - 25 * 3600_000).toISOString();
	const rows = [
		["workspace.start_failed", "failed", recent],
		["workspace.start_failed", "failed", recent],
		["workspace.start_failed", "failed", old],
		["workspace.stop_failed", "failed", recent],
		["workspace.force_stop", "ok", recent],
		["workspace.provision_failed", "failed", recent],
		["controller.unreachable", "failed", recent],
		["auth.login", "failed", recent],
		["auth.login", "denied", recent],
		["auth.login", "ok", recent],
	] as const;
	await testDb.db
		.insertInto("audit_events")
		.values([
			...rows.map(([action, result, at]) => ({
				actor: "worker",
				target: "x",
				action,
				result,
				at,
				metadata: null,
			})),
			// Throttled refusals count by their count, not by row.
			{
				actor: "user:x",
				target: "x",
				action: "preview.denied",
				result: "denied",
				at: recent,
				metadata: JSON.stringify({ reason: "not_owner", workspaceId: "x", count: 10 }),
			},
			{
				actor: "user:x",
				target: "x",
				action: "preview.denied",
				result: "denied",
				at: recent,
				metadata: JSON.stringify({
					reason: "host_mismatch",
					workspaceId: "x",
					count: 2,
				}),
			},
		] as never)
		.execute();

	const report = HealthReport.parse((await getHealth()).json());
	expect(report.last24h).toEqual({
		startFailures: 2,
		stopFailures: 1,
		forcedStops: 1,
		provisionFailures: 1,
		controllerOutages: 1,
		signInFailures: 2,
		previewRefusals: 12,
	});
});
