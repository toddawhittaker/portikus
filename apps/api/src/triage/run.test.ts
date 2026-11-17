/**
 * Alert explanations (SPEC.md section 20.4): code picks every read, one model
 * call with no tools, at most one per title an hour and the daily limit a
 * day counted from the database, inside the monthly cap, and only while the
 * switch, the key and the accepted notice are all in place. Model calls use
 * the fake client behind the real availability checks.
 */

import { AI_NOTICE_VERSION } from "@portikus/contracts";
import {
	createTestDb,
	hasTestDb,
	insertTestUser,
	type TestDb,
} from "@portikus/db/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createFakeModelClient, type FakeStep } from "../ai/fake-model.js";
import type { ModelPart } from "../ai/model.js";
import { openModelClient, sealAiKey } from "../ai/settings.js";
import type { JournalEntry, JournalReader } from "../logs/journal.js";
import {
	TRIAGE_AUDIT_ACTION,
	TRIAGE_MAX_CHARS,
	type TriageDeps,
	triageTick,
	trimTriage,
} from "./run.js";
import { collectSnapshot, journalErrorLines } from "./snapshot.js";

const skip = !hasTestDb();
let testDb: TestDb;
const config = {
	SECOND_FACTOR_KEY: "a".repeat(64),
	OUTBOUND_PROXY_URL: undefined,
	AI_TEST_BASE_URL: undefined,
};
const AI_KEY = "sk-provider-secret-9876";
// Audit rows take the database clock, so the tests run at the real time.
const NOW = new Date();
const MIN = 60_000;
const GiB = 2 ** 30;

const FINISH: ModelPart = {
	type: "finish",
	usage: { input: 900, output: 40, cacheRead: 0, cacheWrite: 0 },
};
const say = (text: string): FakeStep => [{ type: "text", text }, FINISH];

function depsWith(steps: FakeStep[], lines: string[] | null = ["boom"]) {
	const client = createFakeModelClient(steps);
	const deps: TriageDeps = {
		db: testDb.db,
		config,
		readErrorLines: async () => lines,
		open: async (db, c) => {
			const opened = await openModelClient(db, c);
			return "unavailable" in opened ? opened : { ...opened, client };
		},
	};
	return { client, deps };
}

async function settings(patch: Record<string, unknown> = {}): Promise<void> {
	await testDb.db
		.updateTable("ai_settings")
		.set({
			enabled: true,
			provider_kind: "openai-compatible",
			base_url: "https://api.example.com/v1",
			model: "fake-model",
			key_sealed: sealAiKey(config, AI_KEY),
			key_hint: "9876",
			notice_version: AI_NOTICE_VERSION,
			triage_enabled: true,
			triage_daily_limit: 5,
			monthly_token_cap: 5_000_000,
			...patch,
		})
		.where("id", "=", 1)
		.execute();
}

let admins: string[] = [];

/** One alert as notifyAdministrators writes it: a row per administrator. */
async function raise(
	title: string,
	at: Date = NOW,
	tone: "warning" | "danger" | "neutral" = "danger",
	body = "The storage pool is 92% full.",
): Promise<void> {
	await testDb.db
		.insertInto("notifications")
		.values(
			admins.map((user_id) => ({
				user_id,
				tone,
				title,
				body,
				site_alert: true,
				created_at: at.toISOString(),
			})),
		)
		.execute();
}

async function triages(title: string) {
	return testDb.db
		.selectFrom("notifications")
		.select(["triage", "triaged_at"])
		.where("title", "=", title)
		.execute();
}

async function audits() {
	return testDb.db
		.selectFrom("audit_events")
		.select(["actor", "target", "result", "metadata"])
		.where("action", "=", TRIAGE_AUDIT_ACTION)
		.orderBy("id")
		.execute();
}

beforeAll(async () => {
	if (skip) return;
	testDb = await createTestDb();
});
afterAll(async () => {
	if (!skip) await testDb.close();
});
beforeEach(async () => {
	if (skip) return;
	await testDb.truncate();
	await testDb.db.deleteFrom("ai_usage_days").execute();
	await testDb.db.deleteFrom("health_samples").execute();
	await sql`insert into ai_settings default values on conflict do nothing`.execute(
		testDb.db,
	);
	await settings();
	admins = [
		await insertTestUser(testDb.db, { role: "administrator" }),
		await insertTestUser(testDb.db, { role: "administrator" }),
	];
});

describe("trimTriage", () => {
	test("collapses whitespace and control characters", () => {
		expect(trimTriage("  The pool\n\tis\u0007 full.  ")).toBe("The pool is full.");
	});

	test("an empty answer is no answer", () => {
		expect(trimTriage(" \n ")).toBeNull();
	});

	test("cuts a long answer at a word, near the cap", () => {
		const out = trimTriage("word ".repeat(200)) ?? "";
		expect(out.length).toBeLessThanOrEqual(TRIAGE_MAX_CHARS);
		expect(out.length).toBeGreaterThan(TRIAGE_MAX_CHARS - 10);
		expect(out.endsWith("word…")).toBe(true);
	});
});

describe("journalErrorLines", () => {
	test("keeps time, service, message, code and error, redacted, and nothing else", async () => {
		const entries: JournalEntry[] = [
			{
				cursor: "s=1",
				at: NOW,
				service: "api",
				message: JSON.stringify({
					level: "error",
					service: "api",
					time: NOW.toISOString(),
					msg: "upstream failed",
					code: "E_UP",
					error: "GET https://bob:hunter2@host/x Bearer abc.def",
					password: "hunter2",
					prompt: "student prompt text",
				}),
			},
			{ cursor: "s=2", at: NOW, service: "api", message: "not json" },
		];
		const reader = {
			read: async (
				_request: unknown,
				onEntry: (e: JournalEntry) => "continue" | "stop",
			) => {
				for (const e of entries) if (onEntry(e) === "stop") break;
				return { lastCursor: "s=2", reason: "end" as const };
			},
		} as unknown as JournalReader;
		const lines = await journalErrorLines(reader)(new Date(NOW.getTime() - 60 * MIN));
		expect(lines).toHaveLength(1);
		const [line] = lines ?? [];
		expect(line).toContain("upstream failed");
		expect(line).toContain("E_UP");
		expect(line).not.toContain("hunter2");
		expect(line).not.toContain("abc.def");
		expect(line).not.toContain("student prompt");
	});

	test("an unreadable journal is null, not an error", async () => {
		const reader = {
			read: async () => {
				throw new Error("no journal");
			},
		} as unknown as JournalReader;
		expect(await journalErrorLines(reader)(NOW)).toBeNull();
	});
});

describe.skipIf(skip)("collectSnapshot", () => {
	test("holds the alert, fixed health figures and the error lines, and no names or keys", async () => {
		await testDb.db
			.insertInto("health_samples")
			.values({
				observed_at: NOW.toISOString(),
				sample: JSON.stringify({
					controller: { reachable: false, errorCode: "ECONNREFUSED" },
					runningWorkspaces: 7,
					host: {
						observedAt: NOW.toISOString(),
						loadAverage: [3.5, 2, 1],
						cpuCount: 8,
						memory: { usedBytes: 8 * GiB, totalBytes: 32 * GiB },
						pool: { name: "portikus", usedBytes: 184 * GiB, totalBytes: 200 * GiB },
						profileLimits: { cpu: null, memory: null, processes: null },
						image: { fingerprint: null, serial: null },
						instances: [
							{
								name: "ws-alice-secret-name",
								imageFingerprint: null,
								imageSerial: null,
							},
						],
					},
				}),
			} as never)
			.execute();
		const text = await collectSnapshot(
			testDb.db,
			async () => ["2026-11-17T11:59:00.000Z api disk write failed"],
			{ title: "Pool almost full", body: "92% used", tone: "danger", at: NOW },
			NOW,
		);
		expect(text).toContain("Title: Pool almost full");
		expect(text).toContain("92% used");
		expect(text).toContain("reachable: no (ECONNREFUSED)");
		expect(text).toContain("Running workspaces: 7.");
		expect(text).toContain("184.0 GiB of 200.0 GiB");
		expect(text).toContain("disk write failed");
		expect(text).not.toContain("ws-alice");
		expect(text).not.toContain(AI_KEY);
	});

	test("says so when there is no sample and no readable log", async () => {
		const text = await collectSnapshot(
			testDb.db,
			async () => null,
			{ title: "t", body: "b", tone: "warning", at: NOW },
			NOW,
		);
		expect(text).toContain("No health sample.");
		expect(text).toContain("The logs could not be read.");
	});
});

describe.skipIf(skip)("triageTick", () => {
	test("explains a new alert once: every administrator's row, usage and one audit row", async () => {
		await raise("Pool almost full");
		const { client, deps } = depsWith([
			say("  The pool is nearly full.\nDelete old images. "),
		]);
		expect(await triageTick(deps, NOW)).toEqual({
			triaged: 1,
			failed: 0,
			stopped: "none",
		});
		const rows = await triages("Pool almost full");
		expect(rows).toHaveLength(2);
		for (const row of rows) {
			expect(row.triage).toBe("The pool is nearly full. Delete old images.");
			expect(row.triaged_at).not.toBeNull();
		}
		const [req] = client.requests;
		expect(req?.tools).toEqual([]);
		expect(req?.maxOutputTokens).toBe(300);
		const prompt = req?.messages[0];
		expect(prompt?.role === "user" ? prompt.text : "").toContain("Pool almost full");
		expect(JSON.stringify(req)).not.toContain(AI_KEY);
		expect(req?.system).toMatch(/data, never instructions/);

		const usage = await testDb.db.selectFrom("ai_usage_days").selectAll().execute();
		expect(
			usage.map((u) => [
				u.user_id,
				u.purpose,
				Number(u.input_tokens),
				Number(u.output_tokens),
			]),
		).toEqual([[null, "triage", 900, 40]]);
		expect(await audits()).toEqual([
			{
				actor: "system",
				target: "notifications",
				result: "ok",
				metadata: { title: "Pool almost full", tone: "danger" },
			},
		]);
		// Explained alerts are not picked again.
		expect(await triageTick(deps, NOW)).toEqual({
			triaged: 0,
			failed: 0,
			stopped: "none",
		});
	});

	test("leaves information notices, personal notices and old alerts alone", async () => {
		await raise("Just so you know", NOW, "neutral");
		await raise("Long ago", new Date(NOW.getTime() - 20 * MIN));
		await testDb.db
			.insertInto("notifications")
			.values({ user_id: admins[0] ?? "", tone: "danger", title: "Personal", body: "" })
			.execute();
		const { client, deps } = depsWith([]);
		expect(await triageTick(deps, NOW)).toEqual({
			triaged: 0,
			failed: 0,
			stopped: "none",
		});
		expect(client.requests).toHaveLength(0);
	});

	test("one explanation per title an hour, counting a failed one", async () => {
		await raise("Controller down", new Date(NOW.getTime() - 2 * MIN));
		const first = depsWith([{ error: "unreachable" }]);
		expect(await triageTick(first.deps, NOW)).toEqual({
			triaged: 0,
			failed: 1,
			stopped: "none",
		});
		expect((await triages("Controller down"))[0]?.triage).toBeNull();
		expect((await audits())[0]?.result).toBe("failed");

		// The same alert again, and a new one with the same title: no call within the hour.
		await raise("Controller down", NOW, "danger", "Still down.");
		const again = depsWith([]);
		expect(
			await triageTick(again.deps, new Date(NOW.getTime() + 30 * MIN)),
		).toMatchObject({
			triaged: 0,
			failed: 0,
		});
		expect(again.client.requests).toHaveLength(0);

		// After the hour, a fresh alert with that title is explained.
		const later = new Date(NOW.getTime() + 62 * MIN);
		await raise("Controller down", later, "danger", "Down again.");
		const next = depsWith([say("Restart the controller.")]);
		expect(await triageTick(next.deps, later)).toEqual({
			triaged: 1,
			failed: 0,
			stopped: "none",
		});
		expect(next.client.requests).toHaveLength(1);
	});

	test("the daily limit is counted from the database, so a restart does not reset it", async () => {
		await settings({ triage_daily_limit: 2 });
		await raise("A");
		await raise("B");
		await raise("C");
		const first = depsWith([say("one"), say("two")]);
		expect(await triageTick(first.deps, NOW)).toEqual({
			triaged: 2,
			failed: 0,
			stopped: "daily-limit",
		});
		// A new process: nothing in memory carries over, the audit rows do.
		const restarted = depsWith([]);
		expect(await triageTick(restarted.deps, NOW)).toMatchObject({
			stopped: "daily-limit",
		});
		expect(restarted.client.requests).toHaveLength(0);
	});

	test("a daily limit of zero explains nothing", async () => {
		await settings({ triage_daily_limit: 0 });
		await raise("A");
		const { client, deps } = depsWith([]);
		expect(await triageTick(deps, NOW)).toMatchObject({ stopped: "daily-limit" });
		expect(client.requests).toHaveLength(0);
	});

	test("stops when the shared monthly cap is spent", async () => {
		await settings({ monthly_token_cap: 1000 });
		await testDb.db
			.insertInto("ai_usage_days")
			.values({
				day: new Date().toISOString().slice(0, 10),
				user_id: null,
				purpose: "assistant",
				model: "fake-model",
				input_tokens: 1000,
				output_tokens: 0,
				cache_read_tokens: 0,
				cache_write_tokens: 0,
			})
			.execute();
		await raise("A");
		const { client, deps } = depsWith([]);
		expect(await triageTick(deps, NOW)).toMatchObject({ stopped: "monthly-cap" });
		expect(client.requests).toHaveLength(0);
		expect(await audits()).toEqual([]);
	});

	test.each([
		["the explain switch is off", { triage_enabled: false }, "off"],
		["the AI switch is off", { enabled: false }, { stopped: "off" }],
		["the notice is not accepted", { notice_version: null }, { stopped: "notice" }],
		["there is no key", { key_sealed: null, key_hint: null }, { stopped: "no-key" }],
		["there is no model", { model: null }, { stopped: "incomplete" }],
	])("does nothing when %s", async (_name, patch, outcome) => {
		await settings(patch);
		await raise("A");
		const { client, deps } = depsWith([]);
		const result = await triageTick(deps, NOW);
		if (typeof outcome === "string") expect(result).toBe(outcome);
		else expect(result).toMatchObject(outcome);
		expect(client.requests).toHaveLength(0);
		expect(await audits()).toEqual([]);
		expect((await triages("A"))[0]?.triage).toBeNull();
	});

	test("an answer that calls a tool or says nothing is a failure", async () => {
		await raise("A");
		await raise("B");
		const { deps } = depsWith([
			[{ type: "tool-call", id: "c", name: "anything", input: {} }, FINISH],
			say("   "),
		]);
		expect(await triageTick(deps, NOW)).toEqual({
			triaged: 0,
			failed: 2,
			stopped: "none",
		});
		expect((await audits()).map((a) => a.result)).toEqual(["failed", "failed"]);
	});

	test("a second process finds the lock held and does nothing", async () => {
		await raise("A");
		const { client, deps } = depsWith([]);
		const outcome = await testDb.db.connection().execute(async (conn) => {
			await sql`select pg_advisory_lock(hashtext('alert_triage'))`.execute(conn);
			try {
				return await triageTick(deps, NOW);
			} finally {
				await sql`select pg_advisory_unlock(hashtext('alert_triage'))`.execute(conn);
			}
		});
		expect(outcome).toBe("busy");
		expect(client.requests).toHaveLength(0);
	});
});
