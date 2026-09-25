import {
	CookieJar,
	csrfHeaders,
	loginAs,
	type MockOidcProvider,
	openWorkspaceSocket,
	startMockOidcProvider,
} from "@portikus/auth/testing";
import { type HealthSample, QUOTA_SHRINK_MESSAGE } from "@portikus/contracts";
import { createTestDb, hasTestDb, type TestDb } from "@portikus/db/testing";
import type { FastifyInstance } from "fastify";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { type FakeAgent, startFakeAgent } from "../fake-agent.js";
import { buildTestServer, PUBLIC_URL } from "../test-support.js";
import { type ImageFacts, toImageVersion } from "./admin-workspaces.js";

/**
 * The admin workspace detail, archive and storage routes (SPEC.md §20.1,
 * §20.2; Epic 11 done items 2, 4 to 8).
 */

const skip = !hasTestDb();
const AGENT_TOKEN = "admin-detail-token";

let testDb: TestDb;
let mock: MockOidcProvider;
let agent: FakeAgent;
let app: FastifyInstance;
let alice: CookieJar;
let carol: CookieJar;
let workspaceId: string;

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

async function start(overrides: { AGENT_PORT?: number } = {}): Promise<void> {
	app = buildTestServer(testDb.db, mock.issuer, {
		AGENT_PORT: agent.port,
		...overrides,
	});
	await app.listen({ port: 0, host: "127.0.0.1" });
	alice = new CookieJar();
	await loginAs(app, "alice", alice);
	carol = new CookieJar();
	await loginAs(app, "carol", carol);
	workspaceId = (
		await app.inject({
			method: "POST",
			url: "/workspaces",
			headers: csrfHeaders(alice, PUBLIC_URL),
		})
	).json().id;
}

beforeEach(async () => {
	if (skip) return;
	await testDb.truncate();
	agent.listening.clear();
	return async () => {
		await app?.close();
	};
});

async function markRunning(): Promise<void> {
	await testDb.db
		.updateTable("workspaces")
		.set({
			state: "running",
			agent_address: "127.0.0.1",
			agent_token: `${AGENT_TOKEN}:${workspaceId}`,
		})
		.where("id", "=", workspaceId)
		.execute();
}

function detail() {
	return app.inject({
		method: "GET",
		url: `/admin/workspaces/${workspaceId}`,
		headers: { cookie: carol.cookieHeader() },
	});
}

function post(jar: CookieJar, url: string) {
	return app.inject({ method: "POST", url, headers: csrfHeaders(jar, PUBLIC_URL) });
}

function putQuota(payload: unknown) {
	return app.inject({
		method: "PUT",
		url: `/admin/workspaces/${workspaceId}/quota`,
		headers: csrfHeaders(carol, PUBLIC_URL),
		payload: payload as Record<string, unknown>,
	});
}

async function auditActions(): Promise<
	{ action: string; actor: string; metadata: unknown }[]
> {
	return testDb.db
		.selectFrom("audit_events")
		.select(["action", "actor", "metadata"])
		.where("target", "=", workspaceId)
		.orderBy("id")
		.execute();
}

async function carolId(): Promise<string> {
	const row = await testDb.db
		.selectFrom("users")
		.select("id")
		.where("display_name", "like", "Carol%")
		.executeTakeFirstOrThrow();
	return row.id;
}

function sample(overrides: Partial<HealthSample["host"] & object> = {}): HealthSample {
	return {
		controller: { reachable: true, errorCode: null },
		host: {
			observedAt: new Date().toISOString(),
			loadAverage: [0.1, 0.2, 0.3],
			cpuCount: 4,
			memory: { usedBytes: 1, totalBytes: 2 },
			pool: { name: "default", usedBytes: 1, totalBytes: 2 },
			profileLimits: { cpu: "2", memory: "4GiB", processes: "2000" },
			image: { fingerprint: "newfingerprint0000", serial: "2026.09.9" },
			instances: [],
			...overrides,
		},
	};
}

describe("toImageVersion", () => {
	const facts: ImageFacts = {
		currentFingerprint: "aaaa1111bbbb2222",
		instances: new Map([
			["ws-new", { fingerprint: "aaaa1111bbbb2222", serial: "2026.09.9" }],
			["ws-old", { fingerprint: "cccc3333dddd4444", serial: null }],
		]),
	};

	test("an instance on the current image shows its serial and is current", () => {
		expect(toImageVersion("ws-new", null, facts)).toEqual({
			label: "2026.09.9",
			fingerprint: "aaaa1111bbbb2222",
			current: true,
		});
	});

	test("an instance without a serial falls back to the fingerprint prefix", () => {
		expect(toImageVersion("ws-old", null, facts)).toEqual({
			label: "cccc3333dddd",
			fingerprint: "cccc3333dddd4444",
			current: false,
		});
	});

	test("without a sample, the stored fingerprint is shown and currency is unknown", () => {
		expect(toImageVersion("ws-new", "eeee5555ffff6666", null)).toEqual({
			label: "eeee5555ffff",
			fingerprint: "eeee5555ffff6666",
			current: null,
		});
	});
});

test.skipIf(skip)("a stopped workspace shows Stopped and no live usage", async () => {
	await start();
	const res = await detail();
	expect(res.statusCode).toBe(200);
	const body = res.json();
	expect(body.workspace.id).toBe(workspaceId);
	expect(body.owner.displayName).toMatch(/Alice/);
	expect(body.agent).toBe("stopped");
	expect(body.usage).toBeNull();
	expect(body.storage).toBeNull();
	expect(body.ports).toEqual([]);
	// Epic 10's maintenance routes are registered, so both buttons are on.
	expect(body.capabilities).toEqual({ rebuild: true, resetDocker: true });
});

test.skipIf(skip)(
	"the detail fills storage from the agent's per-class figures",
	async () => {
		await start();
		await markRunning();
		const gib = 1024 ** 3;
		agent.storage.set(workspaceId, {
			home: { usedBytes: 5 * gib, totalBytes: 25 * gib },
			docker: { usedBytes: 2 * gib, totalBytes: 20 * gib },
			recovery: { usedBytes: gib, totalBytes: 3 * gib },
		});
		try {
			const body = (await detail()).json();
			expect(body.storage).toEqual({
				home: { usedBytes: 5 * gib, limitBytes: 25 * gib },
				docker: { usedBytes: 2 * gib, limitBytes: 20 * gib },
				recovery: { usedBytes: gib, limitBytes: 3 * gib },
			});

			// A class the agent could not measure leaves the whole figure null.
			agent.storage.set(workspaceId, {
				home: { usedBytes: 5 * gib, totalBytes: 25 * gib },
				docker: null,
				recovery: { usedBytes: gib, totalBytes: 3 * gib },
			});
			expect((await detail()).json().storage).toBeNull();
		} finally {
			agent.storage.delete(workspaceId);
		}
	},
);

test.skipIf(skip)(
	"an administrator's rebuild shows as the detail's pending operation",
	async () => {
		await start();
		const res = await app.inject({
			method: "POST",
			url: `/admin/workspaces/${workspaceId}/rebuild`,
			headers: csrfHeaders(carol, PUBLIC_URL),
			payload: { resetDocker: false },
		});
		expect(res.statusCode).toBe(202);
		expect((await detail()).json().workspace.pendingOperation).toBe("rebuild");
		expect((await auditActions()).map((a) => a.action)).toContain(
			"workspace.rebuild_requested",
		);
	},
);

test.skipIf(skip)("an unknown workspace is 404", async () => {
	await start();
	const res = await app.inject({
		method: "GET",
		url: `/admin/workspaces/${crypto.randomUUID()}`,
		headers: { cookie: carol.cookieHeader() },
	});
	expect(res.statusCode).toBe(404);
	expect(res.json().code).toBe("WORKSPACE_NOT_FOUND");
});

test.skipIf(skip)(
	"a running workspace shows live usage, ports and preview sessions, and nothing secret",
	async () => {
		await start();
		await markRunning();
		agent.listening.set(workspaceId, [
			{
				port: 3000,
				addresses: ["0.0.0.0"],
				protocolHint: "http",
				process: {
					pid: 9,
					command: "node",
					commandLine: "node server.js --token=hunter2",
				},
				previewReachability: "reachable",
				system: false,
				observedAt: new Date().toISOString(),
			},
		]);
		const session = await testDb.db
			.selectFrom("sessions")
			.innerJoin("users", "users.id", "sessions.user_id")
			.select(["sessions.id", "sessions.user_id"])
			.where("users.display_name", "like", "Alice%")
			.executeTakeFirstOrThrow();
		await testDb.db
			.insertInto("preview_sessions")
			.values({
				token_hash: "hash-1",
				user_id: session.user_id,
				session_id: session.id,
				workspace_id: workspaceId,
				port: 3000,
				preview_host: "x.preview.localhost",
			})
			.execute();

		// The registry connects to the agent within a few polls.
		let body = (await detail()).json();
		for (let i = 0; i < 100 && body.ports.length === 0; i++) {
			await new Promise((resolve) => setTimeout(resolve, 50));
			body = (await detail()).json();
		}

		expect(body.agent).toBe("answering");
		expect(body.usage).toEqual({
			cpuPercent: 1.5,
			memory: { usedBytes: 100, totalBytes: 200 },
			disk: { usedBytes: 300, totalBytes: 400 },
		});
		expect(body.ports).toEqual([
			{ port: 3000, command: "node", previewReachability: "reachable", system: false },
		]);
		expect(body.previewSessions).toHaveLength(1);
		expect(body.previewSessions[0].port).toBe(3000);

		const text = JSON.stringify(body);
		for (const key of [
			"commandLine",
			"processes",
			"agent_token",
			"agentToken",
			"hunter2",
		]) {
			expect(text).not.toContain(key);
		}
	},
);

test.skipIf(skip)(
	"an administrator's workspace socket never carries listening services",
	async () => {
		await start();
		await markRunning();
		agent.listening.set(workspaceId, [
			{
				port: 3000,
				addresses: ["0.0.0.0"],
				protocolHint: "http",
				process: { pid: 9, command: "node", commandLine: "node s.js --token=hunter2" },
				container: { id: "abc", name: "secret-db" },
				previewReachability: "reachable",
				system: false,
				observedAt: new Date().toISOString(),
			},
		]);
		const admin = await openWorkspaceSocket(app, workspaceId, carol, PUBLIC_URL);
		const owner = await openWorkspaceSocket(app, workspaceId, alice, PUBLIC_URL);
		// The owner seeing the list proves the registry has it.
		for (let i = 0; i < 100; i++) {
			const seen = owner.messages.some(
				(m) => m.type === "listening-services" && m.services.length > 0,
			);
			if (seen) break;
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		expect(
			owner.messages.some(
				(m) => m.type === "listening-services" && m.services.length > 0,
			),
		).toBe(true);
		expect(admin.messages.some((m) => m.type === "listening-services")).toBe(false);
		const text = JSON.stringify(admin.messages);
		for (const key of ["commandLine", "hunter2", "secret-db", "pid"]) {
			expect(text).not.toContain(key);
		}
		await admin.close();
		await owner.close();
	},
);

test.skipIf(skip)("a running workspace whose agent is down says so", async () => {
	await start({ AGENT_PORT: 1 });
	await markRunning();
	const body = (await detail()).json();
	expect(body.agent).toBe("not_answering");
	expect(body.usage).toBeNull();
});

test.skipIf(skip)("the detail asks the agent once, through /usage only", async () => {
	await start();
	await markRunning();
	const before = agent.healthHits;
	const body = (await detail()).json();
	expect(body.agent).toBe("answering");
	expect(body.usage).not.toBeNull();
	expect(agent.healthHits).toBe(before);
});

test.skipIf(skip)("the image version comes from the newest health sample", async () => {
	await start();
	const row = await testDb.db
		.selectFrom("workspaces")
		.select("incus_instance_name")
		.where("id", "=", workspaceId)
		.executeTakeFirstOrThrow();
	await testDb.db
		.insertInto("health_samples")
		.values({
			sample: JSON.stringify(
				sample({
					instances: [
						{
							name: row.incus_instance_name as string,
							imageFingerprint: "newfingerprint0000",
							imageSerial: "2026.09.9",
						},
					],
				}),
			),
		})
		.execute();

	expect((await detail()).json().image).toEqual({
		label: "2026.09.9",
		fingerprint: "newfingerprint0000",
		current: true,
	});
});

test.skipIf(skip)(
	"an administrator stops another user's workspace and the audit names them",
	async () => {
		await start();
		const res = await post(carol, `/workspaces/${workspaceId}/stop`);
		expect(res.statusCode).toBe(202);

		const body = (await detail()).json();
		expect(body.workspace.desiredState).toBe("stopped");
		const stop = body.recentAudit.find(
			(event: { action: string }) => event.action === "workspace.stop_requested",
		);
		expect(stop.actor).toBe(`user:${await carolId()}`);
		expect(stop.actorName).toMatch(/Carol/);
	},
);

test.skipIf(skip)(
	"archive stops the workspace and refuses start and restart",
	async () => {
		await start();
		await testDb.db
			.updateTable("workspaces")
			.set({ desired_state: "running" })
			.where("id", "=", workspaceId)
			.execute();

		const archived = await post(carol, `/admin/workspaces/${workspaceId}/archive`);
		expect(archived.statusCode).toBe(200);
		expect(archived.json().archivedAt).not.toBeNull();
		expect(archived.json().desiredState).toBe("stopped");

		for (const jar of [alice, carol]) {
			for (const action of ["start", "restart"]) {
				const res = await post(jar, `/workspaces/${workspaceId}/${action}`);
				expect(res.statusCode).toBe(409);
				expect(res.json()).toEqual({
					code: "WORKSPACE_ARCHIVED",
					message: "This workspace was archived by an administrator.",
				});
			}
		}
		expect((await post(alice, `/workspaces/${workspaceId}/stop`)).statusCode).toBe(202);

		// Archiving twice writes one audit row.
		await post(carol, `/admin/workspaces/${workspaceId}/archive`);

		const unarchived = await post(carol, `/admin/workspaces/${workspaceId}/unarchive`);
		expect(unarchived.statusCode).toBe(200);
		expect(unarchived.json().archivedAt).toBeNull();
		expect((await post(alice, `/workspaces/${workspaceId}/start`)).statusCode).toBe(
			202,
		);

		const actions = (await auditActions()).map((row) => row.action);
		expect(actions.filter((a) => a === "workspace.archived")).toHaveLength(1);
		expect(actions.filter((a) => a === "workspace.unarchived")).toHaveLength(1);
		const archiveRow = (await auditActions()).find(
			(r) => r.action === "workspace.archived",
		);
		expect(archiveRow?.actor).toBe(`user:${await carolId()}`);
	},
);

test.skipIf(skip)("archive and unarchive of an unknown workspace are 404", async () => {
	await start();
	for (const action of ["archive", "unarchive"]) {
		const res = await post(carol, `/admin/workspaces/${crypto.randomUUID()}/${action}`);
		expect(res.statusCode).toBe(404);
	}
	expect((await post(carol, "/admin/workspaces/not-a-uuid/archive")).statusCode).toBe(
		400,
	);
});

test.skipIf(skip)("storage grows, is audited, and shows as pending", async () => {
	await start();
	// As the worker records it once the volumes exist.
	await testDb.db
		.updateTable("workspaces")
		.set({
			state: "stopped",
			quota_applied: JSON.stringify({ homeGiB: 25, dockerGiB: 20 }),
		})
		.where("id", "=", workspaceId)
		.execute();
	const res = await putQuota({ homeGiB: 40, dockerGiB: 20 });
	expect(res.statusCode).toBe(200);
	// Epic 10's recovery size rides along untouched.
	expect(res.json().quotaConfig).toEqual({
		homeGiB: 40,
		dockerGiB: 20,
		recoveryGiB: 3,
	});

	const row = (await auditActions()).find(
		(r) => r.action === "workspace.quota_updated",
	);
	expect(row?.actor).toBe(`user:${await carolId()}`);
	expect(row?.metadata).toEqual({
		from: { homeGiB: 25, dockerGiB: 20 },
		to: { homeGiB: 40, dockerGiB: 20 },
	});

	// The worker has not applied it yet, so applied and wanted differ.
	const body = (await detail()).json();
	expect(body.workspace.quotaConfig).toEqual({
		homeGiB: 40,
		dockerGiB: 20,
		recoveryGiB: 3,
	});
	expect(body.quotaApplied).toEqual({ homeGiB: 25, dockerGiB: 20 });

	// The same sizes again change nothing and write no row.
	await putQuota({ homeGiB: 40, dockerGiB: 20 });
	const rows = (await auditActions()).filter(
		(r) => r.action === "workspace.quota_updated",
	);
	expect(rows).toHaveLength(1);
});

/** Put the workspace past provisioning with the given stored quota. */
async function setStoredQuota(quota: Record<string, number>): Promise<void> {
	await testDb.db
		.updateTable("workspaces")
		.set({ state: "stopped", quota_config: JSON.stringify(quota) })
		.where("id", "=", workspaceId)
		.execute();
}

async function storedQuota(): Promise<unknown> {
	const row = await testDb.db
		.selectFrom("workspaces")
		.select("quota_config")
		.where("id", "=", workspaceId)
		.executeTakeFirstOrThrow();
	return row.quota_config;
}

test.skipIf(skip)("a quota change keeps recoveryGiB", async () => {
	await start();
	await setStoredQuota({ homeGiB: 25, dockerGiB: 20, recoveryGiB: 10 });
	const res = await putQuota({ homeGiB: 40, dockerGiB: 20 });
	expect(res.statusCode).toBe(200);
	expect(await storedQuota()).toEqual({ homeGiB: 40, dockerGiB: 20, recoveryGiB: 10 });
});

test.skipIf(skip)(
	"a quota change is refused while the workspace is provisioning",
	async () => {
		await start();
		const res = await putQuota({ homeGiB: 40, dockerGiB: 20 });
		expect(res.statusCode).toBe(409);
		expect(res.json().code).toBe("OPERATION_IN_PROGRESS");
	},
);

test.skipIf(skip)(
	"two administrators changing a quota at once: only one lands",
	async () => {
		await start();
		await setStoredQuota({ homeGiB: 25, dockerGiB: 20 });
		// Hold the row so both requests read the old sizes and queue on the update.
		let pending: Promise<Awaited<ReturnType<typeof putQuota>>[]> | undefined;
		let waited = 0;
		await testDb.db.transaction().execute(async (trx) => {
			await sql`select 1 from workspaces where id = ${workspaceId} for update`.execute(
				trx,
			);
			pending = Promise.all([
				putQuota({ homeGiB: 40, dockerGiB: 20 }),
				putQuota({ homeGiB: 30, dockerGiB: 20 }),
			]);
			for (let i = 0; i < 200; i++) {
				const waiting = await sql<{ n: number }>`
					select count(*)::int as n from pg_stat_activity
					where wait_event_type = 'Lock' and datname = current_database()`.execute(
					testDb.db,
				);
				waited = waiting.rows[0]?.n ?? 0;
				if (waited === 2) break;
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
		});
		expect(waited).toBe(2);
		const results = await (pending as NonNullable<typeof pending>);
		expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
		const loser = results.find((r) => r.statusCode === 409);
		expect(loser?.json().code).toBe("OPERATION_IN_PROGRESS");
		const rows = (await auditActions()).filter(
			(r) => r.action === "workspace.quota_updated",
		);
		expect(rows).toHaveLength(1);
		const winner = rows[0]?.metadata as { to: unknown } | undefined;
		expect(await storedQuota()).toEqual(winner?.to);
	},
);

test.skipIf(skip)("storage cannot shrink or pass the cap", async () => {
	await start();
	await setStoredQuota({ homeGiB: 25, dockerGiB: 20 });
	const shrink = await putQuota({ homeGiB: 10, dockerGiB: 20 });
	expect(shrink.statusCode).toBe(400);
	expect(shrink.json()).toEqual({
		code: "VALIDATION_FAILED",
		message: QUOTA_SHRINK_MESSAGE,
	});
	expect((await putQuota({ homeGiB: 2000, dockerGiB: 20 })).statusCode).toBe(400);
	expect((await putQuota({ homeGiB: 30 })).statusCode).toBe(400);

	const missing = await app.inject({
		method: "PUT",
		url: `/admin/workspaces/${crypto.randomUUID()}/quota`,
		headers: csrfHeaders(carol, PUBLIC_URL),
		payload: { homeGiB: 30, dockerGiB: 30 },
	});
	expect(missing.statusCode).toBe(404);
});

// --- Resource guard overrides, lift and clear (ADR 0032, SPEC.md §24.11) ---

function putGuard(payload: unknown, jar: CookieJar = carol) {
	return app.inject({
		method: "PUT",
		url: `/admin/workspaces/${workspaceId}/guard`,
		headers: csrfHeaders(jar, PUBLIC_URL),
		payload: payload as Record<string, unknown>,
	});
}

async function storedGuard(): Promise<unknown> {
	const row = await testDb.db
		.selectFrom("workspaces")
		.select("guard_config")
		.where("id", "=", workspaceId)
		.executeTakeFirstOrThrow();
	return row.guard_config;
}

const THROTTLE = {
	at: "2026-09-25T12:00:00.000Z",
	averagePercent: 97.5,
	thresholdPercent: 80,
	windowMinutes: 30,
	sharePercent: 25,
	allowance: "100ms/100ms",
};

const MEMORY_FLAG = {
	at: "2026-09-25T12:00:00.000Z",
	averagePercent: 93.1,
	thresholdPercent: 90,
	windowMinutes: 30,
};

async function addSamples(id: string, count: number): Promise<void> {
	for (let i = 0; i < count; i++) {
		await testDb.db
			.insertInto("workspace_usage_samples")
			.values({
				workspace_id: id,
				observed_at: new Date(Date.now() - i * 60_000).toISOString(),
				cpu_usage_ns: 1_000_000 * i,
				cpu_limit: 4,
				memory_bytes: 1024,
				memory_limit_bytes: 4096,
			})
			.execute();
	}
}

async function sampleCount(id: string): Promise<number> {
	const row = await testDb.db
		.selectFrom("workspace_usage_samples")
		.select((eb) => eb.fn.countAll<string>().as("n"))
		.where("workspace_id", "=", id)
		.executeTakeFirstOrThrow();
	return Number(row.n);
}

describe("guard overrides", () => {
	beforeEach(async () => {
		if (skip) return;
		await start();
		await testDb.db
			.insertInto("settings")
			.values({ id: 1, shutdown_grace_seconds: 600 })
			.execute();
	});

	test.skipIf(skip)(
		"overrides merge, show in the detail, and audit from and to",
		async () => {
			expect((await putGuard({ cpuThresholdPercent: 95 })).statusCode).toBe(204);
			expect((await putGuard({ idleStopMinutes: 0 })).statusCode).toBe(204);
			expect(await storedGuard()).toEqual({
				cpuThresholdPercent: 95,
				idleStopMinutes: 0,
			});

			const body = (await detail()).json();
			expect(body.guardConfig).toEqual({ cpuThresholdPercent: 95, idleStopMinutes: 0 });
			expect(body.effectiveGuard).toEqual({
				cpuThresholdPercent: 95,
				memoryThresholdPercent: 90,
				windowMinutes: 30,
				throttleSharePercent: 25,
				idleStopMinutes: 0,
			});

			const audits = (await auditActions()).filter(
				(row) => row.action === "workspace.guard_updated",
			);
			expect(audits).toHaveLength(2);
			expect(audits[0]?.actor).toBe(`user:${await carolId()}`);
			expect(audits[1]?.metadata).toEqual({
				from: { cpuThresholdPercent: 95 },
				to: { cpuThresholdPercent: 95, idleStopMinutes: 0 },
			});
		},
	);

	test.skipIf(skip)(
		"null clears one key, and clearing the last leaves no overrides",
		async () => {
			await putGuard({ windowMinutes: 10, throttleSharePercent: 50 });
			await putGuard({ windowMinutes: null });
			expect(await storedGuard()).toEqual({ throttleSharePercent: 50 });
			await putGuard({ throttleSharePercent: null });
			expect(await storedGuard()).toBeNull();
			expect((await detail()).json().effectiveGuard.windowMinutes).toBe(30);
		},
	);

	test.skipIf(skip)("a request that changes nothing writes no audit row", async () => {
		await putGuard({ memoryThresholdPercent: 99 });
		await putGuard({ memoryThresholdPercent: 99 });
		await putGuard({ idleStopMinutes: null });
		const audits = (await auditActions()).filter(
			(row) => row.action === "workspace.guard_updated",
		);
		expect(audits).toHaveLength(1);
	});

	test.skipIf(skip)("out-of-range and unknown overrides are refused", async () => {
		for (const payload of [
			{},
			{ cpuThresholdPercent: 0 },
			{ memoryThresholdPercent: 101 },
			{ windowMinutes: 4 },
			{ windowMinutes: 241 },
			{ throttleSharePercent: 4 },
			{ idleStopMinutes: 5 },
			{ idleStopMinutes: 1441 },
			{ idleStopMinutes: "0" },
			{ somethingElse: 1 },
		]) {
			const res = await putGuard(payload);
			expect(res.statusCode, JSON.stringify(payload)).toBe(400);
			expect(res.json().code).toBe("VALIDATION_FAILED");
		}
		expect(await storedGuard()).toBeNull();
	});

	test.skipIf(skip)(
		"a student cannot set overrides, and an unknown workspace is 404",
		async () => {
			expect((await putGuard({ idleStopMinutes: 0 }, alice)).statusCode).toBe(403);
			expect(await storedGuard()).toBeNull();
			const res = await app.inject({
				method: "PUT",
				url: `/admin/workspaces/${crypto.randomUUID()}/guard`,
				headers: csrfHeaders(carol, PUBLIC_URL),
				payload: { idleStopMinutes: 0 },
			});
			expect(res.statusCode).toBe(404);
		},
	);
});

describe("lift throttle and clear memory flag", () => {
	beforeEach(async () => {
		if (skip) return;
		await start();
	});

	test.skipIf(skip)(
		"lifting clears the throttle, deletes samples, and audits",
		async () => {
			await testDb.db
				.updateTable("workspaces")
				.set({
					cpu_throttle: JSON.stringify(THROTTLE),
					memory_flag: JSON.stringify(MEMORY_FLAG),
				})
				.where("id", "=", workspaceId)
				.execute();
			await addSamples(workspaceId, 5);
			expect((await detail()).json().cpuThrottle).toEqual(THROTTLE);

			const res = await post(carol, `/admin/workspaces/${workspaceId}/lift-throttle`);
			expect(res.statusCode).toBe(204);

			const row = await testDb.db
				.selectFrom("workspaces")
				.select(["cpu_throttle", "memory_flag"])
				.where("id", "=", workspaceId)
				.executeTakeFirstOrThrow();
			expect(row.cpu_throttle).toBeNull();
			// The memory flag is its own mark and stays.
			expect(row.memory_flag).toEqual(MEMORY_FLAG);
			expect(await sampleCount(workspaceId)).toBe(0);
			const audits = (await auditActions()).filter(
				(a) => a.action === "workspace.cpu_throttle_lifted",
			);
			expect(audits).toEqual([
				{
					action: "workspace.cpu_throttle_lifted",
					actor: `user:${await carolId()}`,
					metadata: { reason: "administrator" },
				},
			]);

			// Nothing left to lift.
			const again = await post(carol, `/admin/workspaces/${workspaceId}/lift-throttle`);
			expect(again.statusCode).toBe(409);
			expect(again.json().code).toBe("NOT_THROTTLED");
		},
	);

	test.skipIf(skip)(
		"clearing the memory flag clears it, deletes samples, and audits",
		async () => {
			await testDb.db
				.updateTable("workspaces")
				.set({ memory_flag: JSON.stringify(MEMORY_FLAG) })
				.where("id", "=", workspaceId)
				.execute();
			await addSamples(workspaceId, 3);

			const res = await post(
				carol,
				`/admin/workspaces/${workspaceId}/clear-memory-flag`,
			);
			expect(res.statusCode).toBe(204);
			expect((await detail()).json().memoryFlag).toBeNull();
			expect(await sampleCount(workspaceId)).toBe(0);
			const audits = (await auditActions()).filter(
				(a) => a.action === "workspace.memory_flag_cleared",
			);
			expect(audits).toHaveLength(1);
			expect(audits[0]?.metadata).toEqual({ reason: "administrator" });

			const again = await post(
				carol,
				`/admin/workspaces/${workspaceId}/clear-memory-flag`,
			);
			expect(again.statusCode).toBe(409);
			expect(again.json().code).toBe("NOT_FLAGGED");
		},
	);

	test.skipIf(skip)("nothing to lift is 409 and keeps the samples", async () => {
		await addSamples(workspaceId, 2);
		const lift = await post(carol, `/admin/workspaces/${workspaceId}/lift-throttle`);
		expect(lift.statusCode).toBe(409);
		expect(lift.json().code).toBe("NOT_THROTTLED");
		const clear = await post(
			carol,
			`/admin/workspaces/${workspaceId}/clear-memory-flag`,
		);
		expect(clear.statusCode).toBe(409);
		expect(clear.json().code).toBe("NOT_FLAGGED");
		expect(await sampleCount(workspaceId)).toBe(2);
		const guardAudits = (await auditActions()).filter((a) => a.action.includes("_"));
		expect(guardAudits.map((a) => a.action)).toEqual(["workspace.provision_requested"]);
	});

	test.skipIf(skip)("another workspace's samples are untouched", async () => {
		const bob = new CookieJar();
		await loginAs(app, "bob", bob);
		const other = (
			await app.inject({
				method: "POST",
				url: "/workspaces",
				headers: csrfHeaders(bob, PUBLIC_URL),
			})
		).json().id as string;
		await addSamples(other, 4);
		await testDb.db
			.updateTable("workspaces")
			.set({ cpu_throttle: JSON.stringify(THROTTLE) })
			.where("id", "=", workspaceId)
			.execute();
		await post(carol, `/admin/workspaces/${workspaceId}/lift-throttle`);
		expect(await sampleCount(other)).toBe(4);
	});

	test.skipIf(skip)(
		"a student cannot lift, and an unknown workspace is 404",
		async () => {
			await testDb.db
				.updateTable("workspaces")
				.set({ cpu_throttle: JSON.stringify(THROTTLE) })
				.where("id", "=", workspaceId)
				.execute();
			expect(
				(await post(alice, `/admin/workspaces/${workspaceId}/lift-throttle`))
					.statusCode,
			).toBe(403);
			expect((await detail()).json().cpuThrottle).toEqual(THROTTLE);
			for (const action of ["lift-throttle", "clear-memory-flag"]) {
				const res = await post(
					carol,
					`/admin/workspaces/${crypto.randomUUID()}/${action}`,
				);
				expect(res.statusCode).toBe(404);
			}
		},
	);
});
