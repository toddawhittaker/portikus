import { MAX_NOTIFICATION_BODY_LENGTH } from "@portikus/contracts";
import { createTestDb, hasTestDb, type TestDb } from "@portikus/db/testing";
import { sql } from "kysely";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
	vi,
} from "vitest";
import { oddAuditLines } from "./audit.js";
import { composeDigest, fitBody } from "./compose.js";
import { digestTick, startDigestTimer } from "./send.js";

const skip = !hasTestDb();
// A Wednesday, local time, so this week's Monday 08:00 has passed.
const NOW = new Date(2026, 10, 18, 10, 0);
const DAY = 86_400_000;
const GIB = 1024 ** 3;
const ago = (ms: number) => new Date(NOW.getTime() - ms);
let testDb: TestDb;

beforeAll(async () => {
	if (skip) return;
	testDb = await createTestDb();
});

afterAll(async () => {
	if (skip) return;
	await testDb.close();
});

beforeEach(async () => {
	if (skip) return;
	await testDb.truncate();
	for (const table of [
		"health_samples",
		"api_request_samples",
		"ai_usage_days",
		"agent_usage_days",
		"model_prices",
		"audit_events",
		"notifications",
	] as const)
		await testDb.db.deleteFrom(table).execute();
	await testDb.db
		.insertInto("settings")
		.values({ id: 1, shutdown_grace_seconds: 900 })
		.onConflict((oc) => oc.doNothing())
		.execute();
});

async function user(
	role: "student" | "instructor" | "administrator",
	disabled = false,
) {
	return testDb.db
		.insertInto("users")
		.values({
			oidc_issuer: "http://mock",
			oidc_subject: `subject-${crypto.randomUUID()}`,
			display_name: `Name ${crypto.randomUUID().slice(0, 6)}`,
			email: null,
			role,
			shutdown_grace_seconds: null,
			disabled_at: disabled ? new Date().toISOString() : null,
		} as never)
		.returning("id")
		.executeTakeFirstOrThrow();
}

async function audit(
	action: string,
	opts: { result?: string; at?: Date; actor?: string; metadata?: object } = {},
) {
	await testDb.db
		.insertInto("audit_events")
		.values({
			actor: opts.actor ?? "user:a",
			target: "t",
			action,
			result: opts.result ?? "ok",
			at: (opts.at ?? ago(DAY)).toISOString(),
			metadata: opts.metadata ? JSON.stringify(opts.metadata) : null,
		})
		.execute();
}

function sample(reachable: boolean, running: number, cpu: number) {
	return {
		controller: { reachable, errorCode: null },
		host: reachable
			? {
					observedAt: NOW.toISOString(),
					loadAverage: [0, 0, 0],
					cpuCount: 4,
					memory: { usedBytes: 1, totalBytes: 16 * GIB },
					pool: { name: "portikus", usedBytes: 1, totalBytes: 2 },
					profileLimits: { cpu: null, memory: null, processes: null },
					image: { fingerprint: null, serial: null },
					instances: [],
					rates: {
						cpuPercent: cpu,
						netRxBytesPerSecond: 0,
						netTxBytesPerSecond: 0,
						diskReadBytesPerSecond: 0,
						diskWriteBytesPerSecond: 0,
					},
				}
			: null,
		runningWorkspaces: running,
	};
}

async function seedHealth() {
	for (const [offset, value] of [
		[2 * DAY, sample(true, 4, 35)],
		[2 * DAY - 60_000, sample(true, 9, 62)],
		[2 * DAY - 120_000, sample(false, 9, 0)],
		[2 * DAY - 180_000, sample(true, 5, 20)],
	] as const) {
		await testDb.db
			.insertInto("health_samples")
			.values({
				observed_at: ago(offset).toISOString(),
				sample: JSON.stringify(value),
			} as never)
			.execute();
	}
	await testDb.db
		.insertInto("api_request_samples")
		.values({
			minute: ago(DAY).toISOString(),
			requests: 1200,
			client_errors: 30,
			server_errors: 6,
			websocket_upgrades: 0,
			latency_buckets: [1200, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
		} as never)
		.execute();
}

describe.skipIf(skip)("the digest's figures", () => {
	test("health: reachability, peak CPU, API counts and guard events", async () => {
		await seedHealth();
		await audit("workspace.cpu_throttled", { actor: "worker" });
		await audit("workspace.cpu_throttled", { actor: "worker" });
		await audit("workspace.idle_stopped", { actor: "worker" });
		const body = await composeDigest(testDb.db, NOW);
		expect(body).toContain("answered 75.0% of sampled minutes");
		expect(body).toContain("Peak server CPU: 62%.");
		expect(body).toContain("API: 1200 requests, 6 server errors");
		expect(body).toContain(
			"Usage guard: 2 CPU throttles, 0 memory flags, 1 idle stops.",
		);
	});

	test("health: says so when no samples were recorded", async () => {
		expect(await composeDigest(testDb.db, NOW)).toContain(
			"No health samples were recorded.",
		);
	});

	test("capacity: the peak running count against what 16 GiB holds", async () => {
		await seedHealth();
		const body = await composeDigest(testDb.db, NOW);
		// Both code-help languages on: 32 Traditional or 23 Agentic (docs/CAPACITY.md).
		expect(body).toContain(
			"Peak running workspaces: 9. The server holds about 32 students in a Traditional course or 23 in an Agentic one.",
		);
	});

	test("capacity: with no memory figure it gives the peak and says it cannot estimate", async () => {
		const body = await composeDigest(testDb.db, NOW);
		expect(body).toContain("Peak running workspaces: not recorded.");
		expect(body).toContain("capacity is not estimated");
	});

	test("usage: people, starts, agent sessions, and the built-in AI dollar estimate", async () => {
		const a = await user("student");
		const b = await user("student");
		await audit("auth.login", { actor: `user:${a.id}` });
		await audit("auth.login", { actor: `user:${a.id}` });
		await audit("auth.login", { actor: `user:${b.id}` });
		await audit("auth.login", { actor: "user:old", at: ago(10 * DAY) });
		await audit("auth.login", { actor: "user:failed", result: "failed" });
		for (let i = 0; i < 3; i++) await audit("workspace.start_requested");
		await testDb.db
			.insertInto("agent_usage_days")
			.values({
				user_id: a.id,
				boot_id: crypto.randomUUID(),
				day: ago(DAY).toISOString().slice(0, 10),
				agent: "claude",
				model: "m",
				sessions: 4,
			})
			.execute();
		await testDb.db
			.insertInto("model_prices")
			.values({
				provider: "openai",
				model: "priced-model",
				input_price_per_million: 2,
				output_price_per_million: 10,
				cache_read_ratio: 0.1,
				cache_write_ratio: 1,
				cache_ttl_seconds: 300,
				source_url: "https://example.com/p",
				source_quote: "q",
				checked_at: "2026-01-01T00:00:00Z",
			})
			.execute();
		const day = ago(DAY).toISOString().slice(0, 10);
		await testDb.db
			.insertInto("ai_usage_days")
			.values({
				day,
				user_id: a.id,
				purpose: "assistant",
				model: "priced-model",
				input_tokens: 1_000_000,
				output_tokens: 100_000,
				cache_read_tokens: 0,
				cache_write_tokens: 0,
			})
			.execute();
		const priced = await composeDigest(testDb.db, NOW);
		expect(priced).toContain("2 people signed in. 3 workspace starts.");
		expect(priced).toContain("Coding agents: 4 sessions by 1 people.");
		// 1,000,000 input at $2 plus 100,000 output at $10 per million.
		expect(priced).toContain("Built-in AI: 1,100,000 tokens, about $3.00 estimate.");

		await testDb.db
			.insertInto("ai_usage_days")
			.values({
				day,
				user_id: a.id,
				purpose: "assistant",
				model: "unpriced-model",
				input_tokens: 500,
				output_tokens: 50,
				cache_read_tokens: 0,
				cache_write_tokens: 0,
			})
			.execute();
		expect(await composeDigest(testDb.db, NOW)).toContain(
			"1,100,550 tokens, about $3.00 estimate, partial because some models have no price.",
		);
	});

	test("usage: unpriced models alone give no dollar figure, and no use says not used", async () => {
		expect(await composeDigest(testDb.db, NOW)).toContain("Built-in AI: not used.");
		await testDb.db
			.insertInto("ai_usage_days")
			.values({
				day: ago(DAY).toISOString().slice(0, 10),
				user_id: null,
				purpose: "pricing",
				model: "mystery",
				input_tokens: 10,
				output_tokens: 5,
				cache_read_tokens: 0,
				cache_write_tokens: 0,
			})
			.execute();
		expect(await composeDigest(testDb.db, NOW)).toContain(
			"Built-in AI: 15 tokens, no price on file, so no dollar estimate.",
		);
	});

	test("usage: a positive cost under one cent says so instead of $0.00", async () => {
		await testDb.db
			.insertInto("model_prices")
			.values({
				provider: "openai",
				model: "priced-model",
				input_price_per_million: 2,
				output_price_per_million: 10,
				cache_read_ratio: 0.1,
				cache_write_ratio: 1,
				cache_ttl_seconds: 300,
				source_url: "https://example.com/p",
				source_quote: "q",
				checked_at: "2026-01-01T00:00:00Z",
			})
			.execute();
		const usage = (input: number) =>
			testDb.db
				.deleteFrom("ai_usage_days")
				.execute()
				.then(() =>
					testDb.db
						.insertInto("ai_usage_days")
						.values({
							day: ago(DAY).toISOString().slice(0, 10),
							user_id: null,
							purpose: "pricing",
							model: "priced-model",
							input_tokens: input,
							output_tokens: 0,
							cache_read_tokens: 0,
							cache_write_tokens: 0,
						})
						.execute(),
				)
				.then(() => composeDigest(testDb.db, NOW));
		expect(await usage(100)).toContain("100 tokens, under $0.01 estimate.");
		expect(await usage(0)).toContain("0 tokens, about $0.00 estimate.");
	});
});

describe.skipIf(skip)("the odd audit entries", () => {
	const week = () => oddAuditLines(testDb.db, ago(7 * DAY), NOW);

	test("says nothing odd when nothing matches", async () => {
		await audit("workspace.start_requested");
		expect(await week()).toEqual(["Nothing odd in the audit trail."]);
	});

	test("counts each rule in the fixed list and skips rows outside the week", async () => {
		await audit("preview.denied", { result: "denied" });
		await audit("auth.login", { result: "denied" });
		await audit("api_key.used", { metadata: { operation: "users.disable" } });
		await audit("assistant.used", { metadata: { operation: "workspaces.archive" } });
		// Not destructive, or not allowed: not counted.
		await audit("api_key.used", { metadata: { operation: "users.list" } });
		await audit("api_key.used", {
			result: "denied",
			metadata: { operation: "users.disable" },
		});
		await audit("admin.root_shell_opened");
		await audit("user.linked");
		await audit("api_key.created");
		await audit("api_key.rotated");
		await audit("api_key.revoked");
		await audit("user.role_changed", {
			metadata: { from: "student", to: "administrator" },
		});
		await audit("user.role_changed", {
			metadata: { from: "administrator", to: "student" },
		});
		await audit("user.password_reset_requested");
		await audit("auth.second_factor_reset");
		await audit("admin.root_shell_opened", { at: ago(9 * DAY) });
		expect(await week()).toEqual([
			"Denied requests: 3.",
			"Destructive operations through an API key or the assistant: 2.",
			"Root shell sessions opened: 1.",
			"Accounts linked (this acts as the other person): 1.",
			"API keys made or rotated: 2.",
			"Administrator or instructor roles granted: 1.",
			"Password or second-factor resets: 2.",
		]);
	});

	test("never puts an actor, a target or any metadata value in the digest", async () => {
		const secrets = ["SECRET-KEY-VALUE", "hunter2-password", "user:secret-actor"];
		await audit("api_key.created", {
			actor: secrets[2],
			metadata: {
				secret: secrets[0],
				password: secrets[1],
				operation: "users.disable",
			},
		});
		await audit("api_key.used", {
			actor: secrets[2],
			metadata: {
				operation: "users.disable",
				secret: secrets[0],
				password: secrets[1],
			},
		});
		const body = await composeDigest(testDb.db, NOW);
		expect(body).toContain("API keys made or rotated: 1.");
		for (const secret of secrets) expect(body).not.toContain(secret);
	});
});

describe("fitBody", () => {
	test("joins headed sections with blank lines", () => {
		expect(
			fitBody([
				["A", ["one", "two"]],
				["B", ["three"]],
			]),
		).toBe("A\none\ntwo\n\nB\nthree");
	});

	test("cuts a body over the notification limit to exactly the limit", () => {
		const body = fitBody([["Long", ["x".repeat(MAX_NOTIFICATION_BODY_LENGTH + 500)]]]);
		expect(body).toHaveLength(MAX_NOTIFICATION_BODY_LENGTH);
		expect(body.endsWith("…")).toBe(true);
	});

	test("cuts at the end of a whole line, never mid-word", () => {
		const lines = Array.from({ length: 200 }, (_, i) => `line number ${i} here`);
		const body = fitBody([["Long", lines]]);
		expect(body.length).toBeLessThanOrEqual(MAX_NOTIFICATION_BODY_LENGTH);
		expect(body.endsWith("\n…")).toBe(true);
		for (const line of body.slice(0, -2).split("\n").slice(1))
			expect(line).toMatch(/^line number \d+ here$/);
	});

	test("leaves a body at the limit alone", () => {
		const text = "y".repeat(MAX_NOTIFICATION_BODY_LENGTH - "S\n".length);
		expect(fitBody([["S", [text]]])).toHaveLength(MAX_NOTIFICATION_BODY_LENGTH);
	});
});

describe.skipIf(skip)("a full digest", () => {
	test("fits 2,000 characters with every section populated", async () => {
		await seedHealth();
		const a = await user("student");
		await audit("auth.login", { actor: `user:${a.id}` });
		for (const action of [
			"admin.root_shell_opened",
			"user.linked",
			"api_key.created",
			"user.password_reset_requested",
		])
			await audit(action);
		await audit("preview.denied", { result: "denied" });
		const body = await composeDigest(testDb.db, NOW);
		expect(body.length).toBeLessThanOrEqual(MAX_NOTIFICATION_BODY_LENGTH);
		for (const heading of ["Health", "Capacity", "Usage", "Audit"])
			expect(body).toContain(`${heading}\n`);
	});

	test("the Audit section comes first, so a cut cannot hide it", async () => {
		await audit("admin.root_shell_opened");
		expect((await composeDigest(testDb.db, NOW)).startsWith("Audit\n")).toBe(true);
	});
});

describe.skipIf(skip)("digestTick", () => {
	async function sentAt() {
		const row = await testDb.db
			.selectFrom("settings")
			.select("digest_sent_at")
			.where("id", "=", 1)
			.executeTakeFirstOrThrow();
		return row.digest_sent_at;
	}
	const notices = () =>
		testDb.db
			.selectFrom("notifications")
			.select(["user_id", "tone", "title", "body"])
			.where("title", "=", "Weekly summary")
			.execute();

	test("sends one information notification to each enabled administrator and stamps the week", async () => {
		const one = await user("administrator");
		const two = await user("administrator");
		await user("administrator", true);
		await user("instructor");
		expect(await digestTick(testDb.db, NOW)).toBe("sent");
		const rows = await notices();
		expect(rows.map((r) => r.user_id).sort()).toEqual([one.id, two.id].sort());
		expect(rows.every((r) => r.tone === "neutral")).toBe(true);
		expect(await sentAt()).toEqual(NOW);
		const [row] = rows;
		expect(row?.body.length).toBeLessThanOrEqual(MAX_NOTIFICATION_BODY_LENGTH);
	});

	test("a second tick, or a restart, in the same week sends nothing more", async () => {
		await user("administrator");
		await digestTick(testDb.db, NOW);
		expect(await digestTick(testDb.db, new Date(NOW.getTime() + 60_000))).toBe(
			"not-due",
		);
		expect(await digestTick(testDb.db, new Date(2026, 10, 22, 23, 0))).toBe("not-due");
		expect(await notices()).toHaveLength(1);
	});

	test("is quiet before Monday 08:00, then sends once after it", async () => {
		await user("administrator");
		await testDb.db
			.updateTable("settings")
			.set({ digest_sent_at: new Date(2026, 10, 9, 8, 1).toISOString() })
			.execute();
		expect(await digestTick(testDb.db, new Date(2026, 10, 16, 7, 59))).toBe("not-due");
		expect(await digestTick(testDb.db, new Date(2026, 10, 16, 8, 0))).toBe("sent");
		expect(await digestTick(testDb.db, new Date(2026, 10, 16, 8, 10))).toBe("not-due");
		expect(await notices()).toHaveLength(1);
	});

	test("after several missed weeks it sends one digest, not one per week", async () => {
		await user("administrator");
		await testDb.db
			.updateTable("settings")
			.set({ digest_sent_at: new Date(2026, 9, 26, 8, 1).toISOString() })
			.execute();
		expect(await digestTick(testDb.db, NOW)).toBe("sent");
		expect(await digestTick(testDb.db, NOW)).toBe("not-due");
		expect(await notices()).toHaveLength(1);
	});

	test("two ticks at once send only once", async () => {
		await user("administrator");
		const results = await Promise.all([
			digestTick(testDb.db, NOW),
			digestTick(testDb.db, NOW),
		]);
		expect(results.sort()).toEqual(["not-due", "sent"]);
		expect(await notices()).toHaveLength(1);
	});

	test("with no settings row it does nothing", async () => {
		await testDb.db.deleteFrom("settings").execute();
		expect(await digestTick(testDb.db, NOW)).toBe("not-due");
	});

	test("a failed send leaves the week unclaimed so the next tick tries again", async () => {
		await user("administrator");
		const before = new Date(2026, 10, 9, 8, 1);
		await testDb.db
			.updateTable("settings")
			.set({ digest_sent_at: before.toISOString() })
			.execute();
		// Without its table the notification fails.
		await sql`alter table notifications rename to notifications_away`.execute(
			testDb.db,
		);
		try {
			await expect(digestTick(testDb.db, NOW)).rejects.toThrow();
		} finally {
			await sql`alter table notifications_away rename to notifications`.execute(
				testDb.db,
			);
		}
		expect(await sentAt()).toEqual(before);
		expect(await digestTick(testDb.db, NOW)).toBe("sent");
	});

	test("one administrator's insert failing leaves no rows and the week unclaimed, and a retry sends exactly once", async () => {
		const one = await user("administrator");
		const two = await user("administrator");
		await sql`
			create function fail_digest_for_one() returns trigger as $$
			begin
				if new.user_id = '${sql.raw(two.id)}'::uuid then
					raise exception 'insert refused';
				end if;
				return new;
			end $$ language plpgsql`.execute(testDb.db);
		await sql`create trigger fail_digest before insert on notifications
			for each row execute function fail_digest_for_one()`.execute(testDb.db);
		try {
			await expect(digestTick(testDb.db, NOW)).rejects.toThrow("insert refused");
		} finally {
			await sql`drop trigger fail_digest on notifications`.execute(testDb.db);
			await sql`drop function fail_digest_for_one()`.execute(testDb.db);
		}
		expect(await notices()).toHaveLength(0);
		expect(await sentAt()).toBeNull();
		expect(await digestTick(testDb.db, NOW)).toBe("sent");
		expect((await notices()).map((r) => r.user_id).sort()).toEqual(
			[one.id, two.id].sort(),
		);
		expect(await digestTick(testDb.db, NOW)).toBe("not-due");
	});
});

describe("startDigestTimer", () => {
	afterEach(() => vi.useRealTimers());

	test("logs a failed tick and stops when told to", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		const error = vi.fn();
		const stop = startDigestTimer({} as never, { error } as never);
		await vi.advanceTimersByTimeAsync(10 * 60_000);
		expect(error).toHaveBeenCalledTimes(1);
		stop();
		await vi.advanceTimersByTimeAsync(30 * 60_000);
		expect(error).toHaveBeenCalledTimes(1);
	});

	test.skipIf(skip)("sends the digest when a tick finds it due", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		await user("administrator");
		const stop = startDigestTimer(testDb.db, { error: vi.fn() } as never);
		await vi.advanceTimersByTimeAsync(10 * 60_000);
		try {
			await vi.waitFor(async () => {
				const rows = await testDb.db
					.selectFrom("notifications")
					.select("title")
					.where("title", "=", "Weekly summary")
					.execute();
				expect(rows).toHaveLength(1);
			});
		} finally {
			stop();
		}
	});
});
