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
	expect(body.capabilities).toEqual({ rebuild: false, resetDocker: false });
});

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

test.skipIf(skip)("capabilities turn on once Epic 10's routes exist", async () => {
	app = buildTestServer(testDb.db, mock.issuer, { AGENT_PORT: agent.port });
	app.post("/admin/workspaces/:id/rebuild", async () => ({}));
	app.post("/workspaces/:id/reset-docker", async () => ({}));
	await app.ready();
	carol = new CookieJar();
	await loginAs(app, "carol", carol);
	alice = new CookieJar();
	await loginAs(app, "alice", alice);
	workspaceId = (await post(alice, "/workspaces")).json().id;

	expect((await detail()).json().capabilities).toEqual({
		rebuild: true,
		resetDocker: true,
	});
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
	expect(res.json().quotaConfig).toEqual({ homeGiB: 40, dockerGiB: 20 });

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
	expect(body.workspace.quotaConfig).toEqual({ homeGiB: 40, dockerGiB: 20 });
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
